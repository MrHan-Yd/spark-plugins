//! Spark native 插件「进程终结者」入口:端口/PID/进程名聚合搜索并结束进程。
//!
//! 生命周期(纯应用模型):用户打开插件页面 → 页面首次 `spark.rpc` 时 host 才
//! spawn 本进程;关闭页面 → `plugin.shutdown` → 进程回收。无任何本地状态,
//! 每次搜索都现场枚举(sysinfo)+ 现场拉端口表(GetExtendedTcpTable/UdpTable)。

mod kill;
mod ports;
mod procs;
mod proto;

use proto::{err_response, ok_response, value_or_err, PluginPageParams, RpcRequest};
use serde_json::{json, Value};
use std::io::{self, Write};
use sysinfo::System;

const PLUGIN_ID: &str = "com.spark.process-killer";
const SDK_VERSION: &str = "process-killer-0.1.0";

struct App {
    sys: System,
}

fn main() {
    let mut app = App { sys: System::new() };

    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut stdout = io::stdout().lock();

    loop {
        let body = match proto::read_frame(&mut reader) {
            Ok(Some(b)) => b,
            Ok(None) => break, // host 关闭管道:退出
            Err(e) => {
                eprintln!("process-killer: read frame failed: {e}");
                break;
            }
        };
        let req: RpcRequest = match serde_json::from_slice(&body) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("process-killer: bad rpc request: {e}");
                continue;
            }
        };
        let id = req.id.clone().unwrap_or(Value::Null);
        let has_id = req.id.is_some();
        let is_shutdown = req.method == "plugin.shutdown";
        let response = match req.method.as_str() {
            "plugin.initialize" => Some(ok_response(
                id,
                json!({ "plugin_id": PLUGIN_ID, "sdk_version": SDK_VERSION }),
            )),
            "plugin.page" => match serde_json::from_value::<PluginPageParams>(req.params) {
                Ok(page) => match handle_page(&mut app, &page.method, &page.args) {
                    Ok(v) => Some(value_or_err(id, &v)),
                    Err(msg) => Some(err_response(id, -32000, &msg)),
                },
                Err(e) => Some(err_response(id, -32602, &format!("bad page params: {e}"))),
            },
            "plugin.shutdown" => {
                if has_id {
                    Some(ok_response(id, json!({ "ok": true })))
                } else {
                    None
                }
            }
            other => {
                eprintln!("process-killer: unknown method {other}");
                if has_id {
                    Some(err_response(id, -32601, "method not found"))
                } else {
                    None
                }
            }
        };
        if let Some(v) = response {
            let body = v.to_string();
            if proto::write_frame(&mut stdout, body.as_bytes()).is_err() {
                break;
            }
        }
        if is_shutdown {
            let _ = stdout.flush();
            break;
        }
    }
}

/// `plugin.page` 方法路由;Err 消息会作为 JSON-RPC error 回给页面(Promise reject)。
fn handle_page(app: &mut App, method: &str, args: &Value) -> Result<Value, String> {
    match method {
        "search" => search(app, args),
        "kill" => do_kill(app, args),
        "locate" => locate(app, args),
        other => Err(format!("未知方法:{other}")),
    }
}

/// 聚合搜索:现场枚举进程 + 现场拉端口表,按查询形态匹配打分。
fn search(app: &mut App, args: &Value) -> Result<Value, String> {
    let q = args
        .get("q")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let t0 = std::time::Instant::now();
    procs::refresh(&mut app.sys);
    let ports = ports::port_map();
    let query = procs::parse_query(&q);
    let (rows, total, procs_total) = procs::collect(&app.sys, &ports, &query, procs::MAX_ROWS);
    Ok(json!({
        "rows": rows,
        "total": total,
        "procs_total": procs_total,
        "took_ms": t0.elapsed().as_millis() as u64,
        "self_pid": std::process::id(),
    }))
}

/// 结束进程;mode = "graceful"(taskkill 发 WM_CLOSE)或 "force"(TerminateProcess)。
fn do_kill(app: &mut App, args: &Value) -> Result<Value, String> {
    let pid = pid_of(args)?;
    let mode = args
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("force")
        .to_string();
    if mode != "graceful" && mode != "force" {
        return Err(format!("未知结束方式:{mode}"));
    }
    // 取进程名做保护名单判断(拿不到名字时仍有 pid 层硬拒绝兜底)
    procs::refresh_one(&mut app.sys, pid);
    let name = app
        .sys
        .process(sysinfo::Pid::from_u32(pid))
        .map(|p| p.name().to_string_lossy().into_owned())
        .unwrap_or_default();
    kill::kill(pid, &name, mode == "graceful")
}

/// 在资源管理器中定位进程 exe 所在目录(hosts-switcher reveal 先例)。
fn locate(app: &mut App, args: &Value) -> Result<Value, String> {
    let pid = pid_of(args)?;
    procs::refresh_one(&mut app.sys, pid);
    let exe = app
        .sys
        .process(sysinfo::Pid::from_u32(pid))
        .and_then(|p| p.exe().map(|e| e.display().to_string()))
        .unwrap_or_default();
    if exe.is_empty() {
        return Err("未取到该进程的可执行文件路径(可能无权限读取)".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{exe}"))
            .spawn()
            .map_err(|e| format!("打开资源管理器失败:{e}"))?;
    }
    Ok(json!({ "ok": true }))
}

fn pid_of(args: &Value) -> Result<u32, String> {
    let n = args.get("pid").and_then(|v| v.as_u64()).ok_or("缺少 pid")?;
    if n > u32::MAX as u64 {
        return Err("pid 超出范围".into());
    }
    Ok(n as u32)
}