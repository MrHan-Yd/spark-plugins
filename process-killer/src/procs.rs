//! 进程枚举(sysinfo)+ 聚合查询解析与打分。
//!
//! 查询形态(精确命中之外带模糊候选,精确分数恒高于模糊,结果按相关度排序):
//! - 空 → 无结果(页面显示引导);
//! - 纯数字 → PID 精确 + 端口占用精确,再各退一级**前缀模糊**(查 11111 输 11 即出候选,渐进收窄);
//! - 条件序列(AND):`:8080` / `port:8080` / `端口:8080` → 端口(精确+前缀);
//!   `pid:1234` → PID(精确+前缀);
//! - 其余 token → 名称/路径子串(大小写不敏感),再退一级**子序列模糊**(打字缺字也命中,
//!   如 `chrme` → chrome)。

use serde::Serialize;
use std::collections::HashMap;
use sysinfo::{Pid, System};

pub const MAX_ROWS: usize = 200;
/// 每行最多展示的端口徽章数(LISTEN/UDP 优先),其余进 ports_more 计数。
const PORTS_PER_ROW: usize = 10;

#[derive(Debug, Serialize, Clone)]
pub struct PortEntry {
    pub proto: &'static str, // "tcp" | "udp"
    pub addr: String,
    pub port: u16,
    pub state: String, // "LISTEN" | "ESTABLISHED" | "BIND"
}

#[derive(Serialize)]
pub struct Row {
    pub pid: u32,
    pub name: String,
    pub exe: String,
    pub cmd: String,
    pub mem: u64,
    pub start_time: u64,
    pub parent: u32,
    pub ports: Vec<PortEntry>,
    pub ports_more: usize,
    pub tags: Vec<String>,
    pub score: f64,
}

/// 聚合查询条件:端口 / PID / 文本(名称或路径子串)。
#[derive(Debug, PartialEq, Clone)]
pub enum Cond {
    Port(u16),
    Pid(u32),
    Text(String),
}

#[derive(Debug)]
pub enum Query {
    Empty,
    /// 纯数字:PID 命中或端口占用,任一即出。
    Num(u64),
    /// 多条件 AND。
    Conds(Vec<Cond>),
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// 模糊(子序列)匹配:pat 的字符按原顺序逐个出现在 s 中即命中,不要求连续。
fn is_subsequence(pat: &str, s: &str) -> bool {
    let mut it = s.chars();
    pat.chars().all(|pc| it.any(|sc| sc == pc))
}

pub fn parse_query(q: &str) -> Query {
    let q = q.trim();
    if q.is_empty() {
        return Query::Empty;
    }
    // 整串纯数字 → PID+端口双路
    if all_digits(q) {
        if let Ok(n) = q.parse::<u64>() {
            return Query::Num(n);
        }
        return Query::Conds(vec![Cond::Text(q.to_lowercase())]);
    }
    let mut conds: Vec<Cond> = Vec::new();
    let toks: Vec<&str> = q.split_whitespace().collect();
    let mut i = 0;
    while i < toks.len() {
        i += 1 + push_cond(&mut conds, toks[i], toks.get(i + 1).copied());
    }
    if conds.is_empty() {
        Query::Empty
    } else {
        Query::Conds(conds)
    }
}

/// 把一个 token 转成条件;返回额外消费的 token 数(pid 1234 / port 8080 这类双 token 形式)。
fn push_cond(conds: &mut Vec<Cond>, tok: &str, next: Option<&str>) -> usize {
    let t = tok.to_lowercase();
    // 单 token 形式:pid:123 / port:80 / 端口:80 / :80
    if let Some(rest) = t.strip_prefix(':') {
        if all_digits(rest) {
            push_port(conds, rest.parse::<u64>().unwrap_or(0));
            return 0;
        }
    }
    if let Some(rest) = t.strip_prefix("pid:") {
        if all_digits(rest) {
            push_pid(conds, rest.parse::<u64>().unwrap_or(0));
            return 0;
        }
    }
    if let Some(rest) = t.strip_prefix("port:") {
        if all_digits(rest) {
            push_port(conds, rest.parse::<u64>().unwrap_or(0));
            return 0;
        }
    }
    if let Some(rest) = t.strip_prefix("端口:") {
        if all_digits(rest) {
            push_port(conds, rest.parse::<u64>().unwrap_or(0));
            return 0;
        }
    }
    // 双 token 形式:pid 123 / port 80 / 端口 80
    if (t == "pid" || t == "port" || t == "端口") && next.map(all_digits).unwrap_or(false) {
        let n = next.unwrap().parse::<u64>().unwrap_or(0);
        if t == "pid" {
            push_pid(conds, n);
        } else {
            push_port(conds, n);
        }
        return 1;
    }
    conds.push(Cond::Text(t));
    0
}

fn push_port(conds: &mut Vec<Cond>, n: u64) {
    if n <= 65535 {
        conds.push(Cond::Port(n as u16));
    } else {
        conds.push(Cond::Text(n.to_string()));
    }
}

fn push_pid(conds: &mut Vec<Cond>, n: u64) {
    if n <= u32::MAX as u64 {
        conds.push(Cond::Pid(n as u32));
    } else {
        conds.push(Cond::Text(n.to_string()));
    }
}

/// 聚合快照 → 结果行。返回 (截断后的 rows, 命中总数, 全系统进程数)。
pub fn collect(
    sys: &System,
    ports: &HashMap<u32, Vec<PortEntry>>,
    query: &Query,
    cap: usize,
) -> (Vec<Row>, usize, usize) {
    let mut rows: Vec<Row> = Vec::new();
    let procs_total = sys.processes().len();
    if matches!(query, Query::Empty) {
        return (rows, 0, procs_total);
    }
    for (pid, p) in sys.processes() {
        let pid = pid.as_u32();
        let name = p.name().to_string_lossy().into_owned();
        let name_l = name.to_lowercase();
        let exe = p
            .exe()
            .map(|e| e.display().to_string())
            .unwrap_or_default();
        let exe_l = exe.to_lowercase();
        let cmd = p
            .cmd()
            .iter()
            .map(|c| c.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        let pents = ports.get(&pid).cloned().unwrap_or_default();

        let (tags, score) = match query {
            Query::Empty => continue,
            Query::Num(n) => {
                let ns = n.to_string();
                let mut tags = Vec::new();
                let mut score = 0.0;
                let mut take = false;
                if *n <= u32::MAX as u64 {
                    if pid == *n as u32 {
                        take = true;
                        tags.push("PID 精确".into());
                        score += 100.0;
                    } else if pid.to_string().starts_with(&ns) {
                        take = true;
                        tags.push("PID 前缀".into());
                        score += 70.0;
                    }
                }
                if *n <= 65535 && pents.iter().any(|e| e.port == *n as u16) {
                    take = true;
                    tags.push(format!("端口 {n}"));
                    score += 95.0;
                } else if pents.iter().any(|e| e.port.to_string().starts_with(&ns)) {
                    take = true;
                    tags.push("端口 前缀".into());
                    score += 65.0;
                }
                if !take {
                    continue;
                }
                (tags, score)
            }
            Query::Conds(conds) => {
                let mut tags: Vec<String> = Vec::new();
                let mut score = 0.0;
                if !conds
                    .iter()
                    .all(|c| cond_match(c, &name_l, &exe_l, &pents, pid, &mut tags, &mut score))
                {
                    continue;
                }
                (tags, score)
            }
        };
        let parent = p.parent().map(|x| x.as_u32()).unwrap_or(0);
        rows.push(Row {
            pid,
            name,
            exe,
            cmd,
            mem: p.memory(),
            start_time: p.start_time(),
            parent,
            ports: Vec::new(), // 下面统一填
            ports_more: 0,
            tags,
            score,
        });
        rows.last_mut().unwrap().fill_ports(&pents);
    }
    rows.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.pid.cmp(&b.pid))
    });
    let total = rows.len();
    rows.truncate(cap);
    (rows, total, procs_total)
}

impl Row {
    /// 展示用端口:LISTEN + UDP 优先(服务视角),ESTABLISHED 参与匹配但不进徽章。
    fn fill_ports(&mut self, pents: &[PortEntry]) {
        let mut show: Vec<PortEntry> = pents
            .iter()
            .filter(|e| e.state == "LISTEN" || e.proto == "udp")
            .cloned()
            .collect();
        show.sort_by_key(|e| e.port);
        self.ports_more = show.len().saturating_sub(PORTS_PER_ROW);
        show.truncate(PORTS_PER_ROW);
        self.ports = show;
    }
}

/// 单条件匹配;命中时把解释性标签与加成分记入 tags/score。
fn cond_match(
    c: &Cond,
    name_l: &str,
    exe_l: &str,
    pents: &[PortEntry],
    pid: u32,
    tags: &mut Vec<String>,
    score: &mut f64,
) -> bool {
    match c {
        Cond::Pid(v) => {
            let vs = v.to_string();
            if pid == *v {
                tags.push("PID".into());
                *score += 40.0;
                true
            } else if pid.to_string().starts_with(&vs) {
                tags.push("PID 前缀".into());
                *score += 25.0;
                true
            } else {
                false
            }
        }
        Cond::Port(v) => {
            let vs = v.to_string();
            if pents.iter().any(|e| e.port == *v) {
                tags.push(format!("端口 {v}"));
                *score += 40.0;
                true
            } else if pents.iter().any(|e| e.port.to_string().starts_with(&vs)) {
                tags.push("端口 前缀".into());
                *score += 25.0;
                true
            } else {
                false
            }
        }
        Cond::Text(t) => {
            if name_l == *t {
                tags.push("名称精确".into());
                *score += 20.0;
                true
            } else if name_l.starts_with(t.as_str()) {
                *score += 14.0;
                true
            } else if name_l.contains(t.as_str()) {
                *score += 10.0;
                true
            } else if exe_l.contains(t.as_str()) {
                tags.push("路径命中".into());
                *score += 6.0;
                true
            } else if is_subsequence(t, &name_l) {
                tags.push("名称模糊".into());
                *score += 5.0;
                true
            } else if is_subsequence(t, &exe_l) {
                tags.push("路径模糊".into());
                *score += 2.0;
                true
            } else {
                false
            }
        }
    }
}

/// 刷新全量进程快照(跳过 CPU/磁盘统计,只取枚举需要的字段)。
pub fn refresh(sys: &mut System) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate};
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_memory()
            .with_exe(sysinfo::UpdateKind::OnlyIfNotSet)
            .with_cmd(sysinfo::UpdateKind::OnlyIfNotSet),
    );
}

/// 只刷新一个 pid(供 kill 前拿进程名做保护名单判断)。
pub fn refresh_one(sys: &mut System, pid: u32) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate};
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        true,
        ProcessRefreshKind::nothing()
            .with_memory()
            .with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conds_of(q: &str) -> Vec<Cond> {
        match parse_query(q) {
            Query::Conds(v) => v,
            other => panic!("expected Conds, got {other:?}"),
        }
    }

    #[test]
    fn empty_queries() {
        assert!(matches!(parse_query(""), Query::Empty));
        assert!(matches!(parse_query("   "), Query::Empty));
    }

    #[test]
    fn pure_number_is_dual_path() {
        assert!(matches!(parse_query("8080"), Query::Num(8080)));
        assert!(matches!(parse_query(" 1234 "), Query::Num(1234)));
        // 超端口范围的纯数字仍是 Num 双路(PID 一路生效)
        assert!(matches!(parse_query("99999999999"), Query::Num(_)));
    }

    #[test]
    fn port_prefix_forms() {
        for q in [":8080", "port:8080", "端口:8080", "port 8080", "端口 8080"] {
            assert_eq!(
                conds_of(q),
                vec![Cond::Port(8080)],
                "query {q} should be Port(8080)"
            );
        }
        // 超 65535 退化为文本
        assert_eq!(conds_of(":70000"), vec![Cond::Text("70000".into())]);
    }

    #[test]
    fn pid_prefix_forms() {
        for q in ["pid:123", "pid 123", "PID 123", "Pid:123"] {
            assert_eq!(conds_of(q), vec![Cond::Pid(123)], "query {q}");
        }
    }

    #[test]
    fn mixed_conds() {
        assert_eq!(
            conds_of("chrome :8080"),
            vec![Cond::Text("chrome".into()), Cond::Port(8080)]
        );
        assert_eq!(
            conds_of("svchost pid:4321"),
            vec![Cond::Text("svchost".into()), Cond::Pid(4321)]
        );
    }

    #[test]
    fn plain_tokens_lowercased() {
        assert_eq!(conds_of("ChRoMe"), vec![Cond::Text("chrome".into())]);
    }

    #[test]
    fn cond_pid_prefix_fuzzy() {
        let mut tags = Vec::new();
        let mut score = 0.0;
        // 前缀:pid 123 命中 1234(模糊标签、低于精确分)
        assert!(cond_match(&Cond::Pid(123), "x", "x", &[], 1234, &mut tags, &mut score));
        assert_eq!(tags, vec!["PID 前缀".to_string()]);
        assert!(score < 40.0);
        // 精确命中仍走精确分支
        tags.clear();
        score = 0.0;
        assert!(cond_match(&Cond::Pid(123), "x", "x", &[], 123, &mut tags, &mut score));
        assert_eq!(tags, vec!["PID".to_string()]);
        assert!(score >= 40.0);
        // 无关 pid 不命中(前缀也救不了)
        tags.clear();
        score = 0.0;
        assert!(!cond_match(&Cond::Pid(123), "x", "x", &[], 987, &mut tags, &mut score));
    }

    #[test]
    fn cond_port_prefix_fuzzy() {
        let pents = vec![PortEntry {
            proto: "tcp",
            addr: "127.0.0.1".into(),
            port: 11111,
            state: "LISTEN".into(),
        }];
        let mut tags = Vec::new();
        let mut score = 0.0;
        // 查 111 → 前缀命中 11111
        assert!(cond_match(&Cond::Port(111), "x", "x", &pents, 1, &mut tags, &mut score));
        assert_eq!(tags, vec!["端口 前缀".to_string()]);
        // 精确优先
        tags.clear();
        score = 0.0;
        assert!(cond_match(&Cond::Port(11111), "x", "x", &pents, 1, &mut tags, &mut score));
        assert!(tags.iter().any(|t| t.contains("11111")));
        // 无关端口不命中
        tags.clear();
        score = 0.0;
        assert!(!cond_match(&Cond::Port(22), "x", "x", &pents, 1, &mut tags, &mut score));
    }

    #[test]
    fn cond_text_fuzzy_tiers() {
        let mut tags = Vec::new();
        let mut score = 0.0;
        // 缺字子序列:chrme → chrome 模糊命中(连续子串都失败后才走这级)
        assert!(cond_match(
            &Cond::Text("chrme".into()),
            "chrome.exe",
            "c:/x/chrome.exe",
            &[],
            1,
            &mut tags,
            &mut score
        ));
        assert_eq!(tags, vec!["名称模糊".to_string()]);
        // 连续子串命中时不打模糊标签
        tags.clear();
        assert!(cond_match(
            &Cond::Text("hrom".into()),
            "chrome.exe",
            "c:/x/chrome.exe",
            &[],
            1,
            &mut tags,
            &mut score
        ));
        assert!(tags.is_empty());
        // 名称全失败 → exe 子序列兜底
        tags.clear();
        score = 0.0;
        assert!(cond_match(
            &Cond::Text("prgra".into()),
            "zzz.exe",
            "c:/program files/x.exe",
            &[],
            1,
            &mut tags,
            &mut score
        ));
        assert_eq!(tags, vec!["路径模糊".to_string()]);
        // 真不匹配
        tags.clear();
        score = 0.0;
        assert!(!cond_match(
            &Cond::Text("xyzw".into()),
            "chrome.exe",
            "c:/x/chrome.exe",
            &[],
            1,
            &mut tags,
            &mut score
        ));
    }

    #[test]
    fn subsequence_basics() {
        assert!(is_subsequence("cme", "chrome.exe"));
        assert!(!is_subsequence("emc", "chrome.exe")); // 乱序不通过
        assert!(is_subsequence("进终结", "进程终结者.exe"));
        assert!(!is_subsequence("结终", "进程终结者.exe"));
        assert!(is_subsequence("", "anything")); // 空 pattern 平凡命中
    }
}