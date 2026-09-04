//! 查询解析 + 匹配打分 + 命中区间。
//!
//! 匹配在文件/目录**名**上进行(不含路径),多关键词空格分词 AND;
//! `ext:pdf` / `.pdf` 过滤扩展名,`d:` 限定盘符。大小写按 ASCII 折叠。
//! 高亮区间用 UTF-16 码元偏移(JS 字符串下标),页面渲染时零换算。

use crate::index::{DirNode, DriveIndex};
use std::sync::Arc;

/// 解析后的查询。`terms` 为 UTF-16 折叠后的小写分词。
#[derive(Debug, Clone)]
pub struct Parsed {
    pub terms: Vec<Vec<u16>>,
    pub ext: Option<Vec<u16>>,
    pub drive: Option<String>,
    /// 是否只剩过滤词没有关键词(这种输入不搜文件,回提示)。
    pub has_terms: bool,
}

/// ASCII 折叠地展开为 UTF-16 码元序列。
pub fn fold_into(s: &str, buf: &mut Vec<u16>) {
    buf.clear();
    buf.extend(s.encode_utf16().map(|c| {
        if (b'A' as u16..=b'Z' as u16).contains(&c) {
            c + 32
        } else {
            c
        }
    }));
}

pub fn parse(text: &str) -> Parsed {
    let mut terms: Vec<Vec<u16>> = Vec::new();
    let mut ext: Option<String> = None;
    let mut drive: Option<String> = None;
    let mut scratch = Vec::new();
    for tok in text.split_whitespace() {
        let t = tok.to_lowercase();
        if let Some(e) = t.strip_prefix("ext:") {
            let e = e.trim_start_matches('.');
            if !e.is_empty() {
                ext = Some(e.to_string());
            }
        } else if t.starts_with('.') && t.len() > 1 {
            ext = Some(t[1..].to_string());
        } else if t.len() == 2
            && t.ends_with(':')
            && t.as_bytes()[0].is_ascii_alphabetic()
        {
            drive = Some(t[..1].to_string());
        } else if !t.is_empty() {
            fold_into(&t, &mut scratch);
            terms.push(scratch.clone());
        }
    }
    let ext_folded = ext.as_ref().map(|e| {
        let mut b = Vec::new();
        fold_into(e, &mut b);
        b
    });
    Parsed {
        has_terms: !terms.is_empty(),
        terms,
        ext: ext_folded,
        drive,
    }
}

/// 命中项。目录的 path 带尾部 `\`。
pub struct Hit {
    pub path: String,
    pub name: String,
    pub subtitle: String,
    pub score: f32,
    pub highlight: Vec<[usize; 2]>,
    pub is_dir: bool,
}

/// 找首个出现位置(热路径,零分配)。
fn find_first(h: &[u16], p: &[u16]) -> Option<usize> {
    if p.is_empty() || p.len() > h.len() {
        return None;
    }
    'outer: for i in 0..=h.len() - p.len() {
        for (j, pc) in p.iter().enumerate() {
            if h[i + j] != *pc {
                continue 'outer;
            }
        }
        return Some(i);
    }
    None
}

/// 找全部出现位置(仅在命中后调用,用于高亮区间)。
fn find_all(h: &[u16], p: &[u16], out: &mut Vec<[usize; 2]>) {
    if p.is_empty() || p.len() > h.len() {
        return;
    }
    'outer: for i in 0..=h.len() - p.len() {
        for (j, pc) in p.iter().enumerate() {
            if h[i + j] != *pc {
                continue 'outer;
            }
        }
        out.push([i, i + p.len()]);
    }
}

fn ext_matches(folded: &[u16], ext: &[u16]) -> bool {
    if ext.is_empty() || ext.len() >= folded.len() {
        return false;
    }
    let tail = &folded[folded.len() - ext.len()..];
    tail == ext && folded[folded.len() - ext.len() - 1] == b'.' as u16
}

/// 名字是否匹配全部分词(+可选扩展名);返回 (分数, 高亮区间)。
fn match_name(
    folded: &[u16],
    terms: &[Vec<u16>],
    ext: Option<&[u16]>,
) -> Option<(f32, Vec<[usize; 2]>)> {
    let mut score = 0.0f32;
    for t in terms {
        let first = find_first(folded, t)?;
        score += if first == 0 { 2.0 } else { 1.0 };
        if folded == t.as_slice() {
            score += 3.0; // 全名精确命中
        }
    }
    if let Some(e) = ext {
        if !ext_matches(folded, e) {
            return None;
        }
        score += 1.5;
    }
    score -= folded.len() as f32 * 0.02; // 同分偏短名
    let mut hl = Vec::new();
    for t in terms {
        find_all(folded, t, &mut hl);
    }
    if let Some(e) = ext {
        // 扩展名命中也纳入高亮:含前导点的 ".pdf" 区段(ext_matches 已通过)
        hl.push([folded.len() - e.len() - 1, folded.len()]);
    }
    Some((score, hl))
}

struct Ctx<'a> {
    parsed: &'a Parsed,
    cap: usize,
    out: Vec<Hit>,
}

fn rec(path: &mut String, node: &DirNode, ctx: &mut Ctx, fold_buf: &mut Vec<u16>) {
    if ctx.out.len() >= ctx.cap {
        return;
    }
    let base = path.len();
    for d in &node.dirs {
        path.push_str(&d.name);
        path.push('\\');
        fold_into(&d.name, fold_buf);
        if let Some((score, hl)) =
            match_name(fold_buf, &ctx.parsed.terms, ctx.parsed.ext.as_deref())
        {
            ctx.out.push(Hit {
                path: path.clone(),
                name: d.name.clone(),
                subtitle: path[..base].to_string(),
                score: score - 0.3,
                highlight: hl,
                is_dir: true,
            });
        }
        rec(path, d, ctx, fold_buf);
        path.truncate(base);
        if ctx.out.len() >= ctx.cap {
            return;
        }
    }
    for f in &node.files {
        if ctx.out.len() >= ctx.cap {
            return;
        }
        path.push_str(f);
        fold_into(f, fold_buf);
        if let Some((score, hl)) =
            match_name(fold_buf, &ctx.parsed.terms, ctx.parsed.ext.as_deref())
        {
            ctx.out.push(Hit {
                path: path.clone(),
                name: f.clone(),
                subtitle: path[..base].to_string(),
                score,
                highlight: hl,
                is_dir: false,
            });
        }
        path.truncate(base);
    }
}

/// 搜索单盘;`cap` 为收集上限(实际展示前会排序截断)。
pub fn search_drive(idx: &DriveIndex, parsed: &Parsed, cap: usize) -> Vec<Hit> {
    let mut ctx = Ctx {
        parsed,
        cap,
        out: Vec::with_capacity(64),
    };
    let mut path = format!("{}\\", idx.drive);
    let mut fold_buf = Vec::with_capacity(64);
    rec(&mut path, &idx.root, &mut ctx, &mut fold_buf);
    ctx.out
}

/// 多盘并行搜索后合并,按分排序截取 `limit`。
pub fn search_parallel(indices: &[Arc<DriveIndex>], parsed: &Parsed, limit: usize) -> Vec<Hit> {
    // 纯扩展名浏览(没关键词)会命中海量文件:多收一些再排序,减少树序偏差。
    let cap = if parsed.terms.is_empty() {
        (limit * 40).max(512)
    } else {
        (limit * 8).max(64)
    };
    if indices.len() == 1 {
        let mut hits = search_drive(&indices[0], parsed, cap);
        sort_hits(&mut hits);
        hits.truncate(limit);
        return hits;
    }
    let mut handles = Vec::with_capacity(indices.len());
    for idx in indices {
        let idx = Arc::clone(idx);
        let p = parsed.clone();
        handles.push(std::thread::spawn(move || search_drive(&idx, &p, cap)));
    }
    let mut all = Vec::new();
    for h in handles {
        if let Ok(hits) = h.join() {
            all.extend(hits);
        }
    }
    sort_hits(&mut all);
    all.truncate(limit);
    all
}

fn sort_hits(hits: &mut [Hit]) {
    hits.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.path.cmp(&b.path))
    });
}