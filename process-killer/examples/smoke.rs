//! 冒烟测试:手动以 host 的方式驱动插件协议帧(纯应用模型:`plugin.page` RPC)。
//! 安全设计:不碰任何真实系统进程——端口验证用本进程自绑的临时端口,kill 验证
//! 用自建子进程(ping),保护名单验证用「复制 cmd.exe 改名为 csrss.exe」的假进程
//! (只触发名单拒绝,不真杀,smoke 侧自行清场)。夹具放 `target/smoke-fixture/`,
//! 跑完自清。运行:`cargo run --example smoke`(仅开发用,不进发布物)。

use serde_json::{json, Value};
use std::io::{BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

fn send(w: &mut impl Write, v: &serde_json::Value) {
    let body = serde_json::to_vec(v).unwrap();
    w.write_all(&(body.len() as u32).to_le_bytes()).unwrap();
    w.write_all(&body).unwrap();
    w.flush().unwrap();
}

fn read_frame(r: &mut impl Read) -> Option<Vec<u8>> {
    let mut h = [0u8; 4];
    r.read_exact(&mut h).ok()?;
    let len = u32::from_le_bytes(h) as usize;
    let mut b = vec![0u8; len];
    r.read_exact(&mut b).ok()?;
    Some(b)
}

fn page(w: &mut impl Write, id: u64, method: &str, args: serde_json::Value) {
    send(
        w,
        &json!({
            "jsonrpc": "2.0", "id": id, "method": "plugin.page",
            "params": { "method": method, "args": args }
        }),
    );
}

static mut FAILS: u32 = 0;

fn check(cond: bool, label: &str) {
    if cond {
        println!("  PASS  {label}");
    } else {
        println!("  FAIL  {label}");
        unsafe { FAILS += 1 };
    }
}

fn result_of(frame: &[u8]) -> Value {
    serde_json::from_slice::<Value>(frame).unwrap_or(Value::Null)
}

/// spawn 一个长时存活、不读 stdin、不污染控制台的子进程;
/// 夹具 csrss.exe 实为 cmd.exe 副本,需要 /c 包一层。
fn spawn_child(exe: &std::path::Path) -> Child {
    let mut c = Command::new(exe);
    if exe
        .file_name()
        .map(|n| n.to_string_lossy().eq_ignore_ascii_case("csrss.exe"))
        .unwrap_or(false)
    {
        c.args(["/c", "ping", "-n", "60", "127.0.0.1"]);
    } else {
        c.args(["-n", "60", "127.0.0.1"]);
    }
    c.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn child")
}

/// 在 search 结果里找指定 pid 的行。
fn find_row(r: &Value, pid: u32) -> bool {
    r.pointer("/result/rows")
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .any(|row| row.get("pid").and_then(|x| x.as_u64()) == Some(pid as u64))
        })
        .unwrap_or(false)
}

fn main() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("smoke-fixture");
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::create_dir_all(&dir);

    // 发布物 exe 存在则冒烟它,否则用 cargo 刚构建的 debug exe
    let shipped = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/0.1.0/spark-plugin-process-killer.exe"
    );
    let debug = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/target/debug/spark-plugin-process-killer.exe"
    );
    let exe = if std::path::Path::new(shipped).exists() {
        shipped
    } else {
        debug
    };

    let mut child = Command::new(exe)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn plugin");
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());

    // 1) 握手
    send(
        &mut input,
        &json!({
            "jsonrpc": "2.0", "id": 1, "method": "plugin.initialize",
            "params": { "id": "com.spark.process-killer", "permissions": [], "api_version": 1 }
        }),
    );
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        r.pointer("/result/plugin_id").and_then(|v| v.as_str())
            == Some("com.spark.process-killer"),
        "initialize 握手",
    );

    let self_pid = std::process::id();

    // 2) 空查询:不报错,rows 为空(页面显示引导)
    page(&mut input, 2, "search", json!({ "q": "" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        r.pointer("/result/rows")
            .map(|v| v.as_array().map(|a| a.is_empty()).unwrap_or(false))
            .unwrap_or(false),
        "空查询返回空结果不报错",
    );
    check(
        r.pointer("/result/procs_total")
            .and_then(|v| v.as_u64())
            .map(|n| n > 0)
            .unwrap_or(false),
        "全系统进程数 > 0",
    );
    // exe 自报的自身 pid,供后面验证「拒绝杀插件自身」
    let exe_self_pid =
        r.pointer("/result/self_pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    check(exe_self_pid != 0, "search 回报 exe 自身 pid");

    // 3) 端口搜索:自绑 127.0.0.1:0 的临时 TCP 端口,必须命中本进程 pid
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().unwrap().port();
    page(&mut input, 3, "search", json!({ "q": format!(":{port}") }));
    let r = result_of(&read_frame(&mut output).unwrap());
    let hit_tags = r
        .pointer("/result/rows")
        .and_then(|v| v.as_array())
        .and_then(|rows| {
            rows.iter()
                .find(|row| row.get("pid").and_then(|x| x.as_u64()) == Some(self_pid as u64))
                .and_then(|row| row.get("tags").and_then(|v| v.as_array()).cloned())
        });
    check(
        hit_tags.is_some(),
        &format!("端口搜索 :{port} 命中本进程 pid {self_pid}"),
    );
    check(
        hit_tags
            .map(|tags| {
                tags.iter()
                    .any(|t| t.as_str().map(|s| s.contains(&port.to_string())).unwrap_or(false))
            })
            .unwrap_or(false),
        "命中行带端口标签",
    );

    // 4) 无占用端口 → 无结果但不报错
    page(&mut input, 4, "search", json!({ "q": ":65530" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        r.pointer("/result/rows")
            .map(|v| v.as_array().map(|a| a.is_empty()).unwrap_or(false))
            .unwrap_or(false),
        "无占用端口返回空结果",
    );

    // 5) PID 前缀搜索
    page(&mut input, 5, "search", json!({ "q": format!("pid:{self_pid}") }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(find_row(&r, self_pid), &format!("pid:{self_pid} 前缀命中本进程"));

    // 6) 纯数字双路:PID 路径生效
    page(&mut input, 6, "search", json!({ "q": self_pid.to_string() }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(find_row(&r, self_pid), "纯数字查询 PID 路径命中本进程");

    // 7) 名称搜索:spawn 真子进程(ping),按名称与 PID 均应命中
    let mut child_a = spawn_child(std::path::Path::new("ping"));
    std::thread::sleep(std::time::Duration::from_millis(500));
    let a_pid = child_a.id();
    page(&mut input, 7, "search", json!({ "q": format!("pid:{a_pid}") }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(find_row(&r, a_pid), "子进程按 PID 命中");
    page(&mut input, 8, "search", json!({ "q": "ping" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(find_row(&r, a_pid), "名称搜索「ping」命中子进程");

    // 8) 强杀子进程:exited=true 且句柄确认退出
    page(&mut input, 9, "kill", json!({ "pid": a_pid, "mode": "force" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        r.pointer("/result/ok").and_then(|v| v.as_bool()) == Some(true)
            && r.pointer("/result/exited").and_then(|v| v.as_bool()) == Some(true),
        "强杀子进程:报告已退出",
    );
    check(child_a.wait().is_ok(), "子进程句柄确认退出");

    // 9) 温和结束:ping.exe 无窗口,taskkill(无 /F)大概率发不出 → 允许 exited:false,
    //    随后强杀兜底(页面「未退出追问强杀」的路径)
    let mut child_b = spawn_child(std::path::Path::new("ping"));
    std::thread::sleep(std::time::Duration::from_millis(500));
    let b_pid = child_b.id();
    page(&mut input, 10, "kill", json!({ "pid": b_pid, "mode": "graceful" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(r.get("result").is_some(), "温和结束请求返回(不 panic)");
    if !r
        .pointer("/result/exited")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        page(&mut input, 11, "kill", json!({ "pid": b_pid, "mode": "force" }));
        let r = result_of(&read_frame(&mut output).unwrap());
        check(
            r.pointer("/result/exited").and_then(|v| v.as_bool()) == Some(true),
            "温和未退出 → 强杀兜底成功",
        );
    }
    let _ = child_b.wait();

    // 10) 保护名单:假 csrss.exe → 名称搜索命中,kill 必须被拒绝,进程存活由 smoke 侧清场
    let fake = dir.join("csrss.exe");
    std::fs::copy(std::path::Path::new("C:\\Windows\\System32\\cmd.exe"), &fake)
        .expect("复制 cmd.exe 为夹具 csrss.exe");
    let mut child_c = spawn_child(&fake);
    std::thread::sleep(std::time::Duration::from_millis(500));
    let c_pid = child_c.id();
    page(&mut input, 12, "search", json!({ "q": "csrss" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(find_row(&r, c_pid), "名称搜索「csrss」命中夹具进程");
    page(&mut input, 13, "kill", json!({ "pid": c_pid, "mode": "force" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        r.get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .map(|m| m.contains("拒绝"))
            .unwrap_or(false),
        "保护名单拒绝杀 csrss.exe",
    );
    let _ = child_c.kill();
    let _ = child_c.wait();

    // 11) 插件自身进程 / pid 4 拒绝(kill 的是 exe 的自身 pid,不是 smoke 的)
    page(&mut input, 14, "kill", json!({ "pid": exe_self_pid, "mode": "force" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        r.get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .map(|m| m.contains("拒绝"))
            .unwrap_or(false),
        "拒绝结束插件自身进程",
    );
    page(&mut input, 15, "kill", json!({ "pid": 4, "mode": "force" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(r.get("error").is_some(), "拒绝结束 pid 4(System)");

    // 12) 不存在的 pid:温和结束应返回 exited=true 而非报错
    page(&mut input, 16, "kill", json!({ "pid": 999999, "mode": "graceful" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        r.pointer("/result/exited").and_then(|v| v.as_bool()) == Some(true),
        "不存在的 pid 报已退出(而非报错)",
    );

    // 13) 前缀模糊:端口去掉末位查询,仍应命中占端口的进程(渐进收窄)
    let port_s = port.to_string();
    let port_prefix = &port_s[..port_s.len() - 1];
    page(&mut input, 17, "search", json!({ "q": format!(":{port_prefix}") }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        find_row(&r, self_pid),
        &format!("端口前缀 :{port_prefix} 命中占用 {port} 的进程"),
    );

    // 14) 前缀模糊:纯数字 PID 去掉末位仍应命中
    let pid_s = self_pid.to_string();
    let pid_prefix = &pid_s[..pid_s.len() - 1];
    page(&mut input, 18, "search", json!({ "q": pid_prefix }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        find_row(&r, self_pid),
        &format!("纯数字 {pid_prefix} 前缀命中 PID {self_pid}"),
    );

    // 15) 文本子序列模糊:「png」(缺 i)应命中 ping 子进程,且不靠连续子串
    let mut child_d = spawn_child(std::path::Path::new("ping"));
    std::thread::sleep(std::time::Duration::from_millis(500));
    let d_pid = child_d.id();
    page(&mut input, 19, "search", json!({ "q": "png" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(find_row(&r, d_pid), "子序列「png」模糊命中 ping.exe");
    page(&mut input, 20, "kill", json!({ "pid": d_pid, "mode": "force" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        r.pointer("/result/exited").and_then(|v| v.as_bool()) == Some(true),
        "模糊用例子进程清场",
    );
    let _ = child_d.wait();

    // 16) 无意义关键词仍然无结果(模糊不等于乱命中)
    page(&mut input, 21, "search", json!({ "q": "zzzzqq" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        r.pointer("/result/rows")
            .map(|v| v.as_array().map(|a| a.is_empty()).unwrap_or(false))
            .unwrap_or(false),
        "无意义关键词仍返回空结果",
    );

    // shutdown 通知(无 id)→ 进程应退出
    send(
        &mut input,
        &json!({ "jsonrpc": "2.0", "method": "plugin.shutdown", "params": null }),
    );
    drop(input);
    match child.wait() {
        Ok(_status) => println!("  PASS  shutdown 退出"),
        Err(e) => {
            println!("  FAIL  shutdown wait 失败: {e}");
            unsafe { FAILS += 1 };
        }
    }

    // 自清
    drop(listener);
    let _ = std::fs::remove_dir_all(&dir);

    let fails = unsafe { FAILS };
    println!(
        "─────\n冒烟结束:{}",
        if fails == 0 { "全部通过".to_string() } else { format!("{fails} 项失败") }
    );
    if fails > 0 {
        std::process::exit(1);
    }
}