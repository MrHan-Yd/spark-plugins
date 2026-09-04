//! Spark native 插件「本地搜索」入口:全盘文件名实时搜索,内存索引。
//!
//! 生命周期(纯应用模型):用户打开插件页面 → 页面首次 `spark.rpc` 时 host 才
//! spawn 本进程 → 启动即后台建索引,建完常驻;用户关闭页面 → `plugin.shutdown`
//! → 进程回收,内存自动释放,磁盘零残留(仅配置文件几 KB)。

mod actions;
mod config;
mod index;
mod proto;
mod search;

use proto::{err_response, ok_response, value_or_err, PluginPageParams, RpcRequest};
use serde_json::{json, Value};
use std::io::{self, Write};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::SystemTime;

const PLUGIN_ID: &str = "com.spark.local-search";
const SDK_VERSION: &str = "local-search-0.1.0";

/// 索引构建是后台功夫:整个进程降到「低于正常」CPU 优先级 + 「很低」I/O 优先级,
/// 前台应用永远优先,弱机上遍历全盘也不会把系统卡住。(kernel32/ntdll 直连,不加依赖)
#[cfg(windows)]
fn set_background_priority() {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn SetPriorityClass(hProcess: isize, dwPriorityClass: u32) -> i32;
    }
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x4000;
    unsafe {
        SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
    }

    // I/O 优先级与 CPU 优先级是两套体系:CPU 让路了,HDD 上的随机读风暴照样卡盘。
    // NtSetInformationProcess(ProcessIoPriority) 自 Vista 起稳定存在,失败则忽略。
    #[link(name = "ntdll")]
    extern "system" {
        fn NtSetInformationProcess(
            ProcessHandle: isize,
            ProcessInformationClass: u32,
            ProcessInformation: *mut u32,
            ProcessInformationLength: u32,
        ) -> i32;
    }
    const PROCESS_IO_PRIORITY: u32 = 0x21;
    const IO_PRIORITY_VERY_LOW: u32 = 0;
    let mut io = IO_PRIORITY_VERY_LOW;
    unsafe {
        NtSetInformationProcess(GetCurrentProcess(), PROCESS_IO_PRIORITY, &mut io, 4);
    }
}

#[cfg(not(windows))]
fn set_background_priority() {}

struct App {
    state: Arc<index::State>,
    config_path: std::path::PathBuf,
    config_mtime: Option<SystemTime>,
}

fn main() {
    set_background_priority();
    let letters = config::enumerate_drive_letters();
    let (config_path, cfg, mtime) = config::ensure_and_load(&letters);
    let state = index::State::new(cfg);
    index::spawn_build(&state);
    let mut app = App {
        state,
        config_path,
        config_mtime: mtime,
    };

    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut stdout = io::stdout().lock();

    loop {
        let body = match proto::read_frame(&mut reader) {
            Ok(Some(b)) => b,
            Ok(None) => break, // host 关闭管道:退出
            Err(e) => {
                eprintln!("local-search: read frame failed: {e}");
                break;
            }
        };
        let req: RpcRequest = match serde_json::from_slice(&body) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("local-search: bad rpc request: {e}");
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
            // `plugin.query`/`invoke`/`cancel` 协议保留但 host 不再发送;走到这里
            // 按未知方法回错(notification 无 id 不回帧,不破坏帧流)。
            "plugin.shutdown" => {
                if has_id {
                    Some(ok_response(id, json!({ "ok": true })))
                } else {
                    None
                }
            }
            other => {
                eprintln!("local-search: unknown method {other}");
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
        "search" => handle_search(app, args),
        "open" | "reveal" | "copy_path" | "copy_file" => actions::handle(method, args, &app.state),
        "get_config" => get_config(app),
        "set_config" => set_config(app, args),
        "rebuild" => {
            index::spawn_build(&app.state);
            Ok(json!({ "ok": true }))
        }
        other => Err(format!("未知方法:{other}")),
    }
}

/// 配置热重载:mtime 变了就重读并触发重建(旧代次结果自动作废)。
fn reload_config_if_changed(app: &mut App) {
    let mtime = fs_mtime(&app.config_path);
    if mtime == app.config_mtime {
        return;
    }
    app.config_mtime = mtime;
    if let Ok(text) = std::fs::read_to_string(&app.config_path) {
        if let Ok(cfg) = serde_json::from_str::<config::Config>(&text) {
            *app.state.config.lock().unwrap() = cfg;
            index::spawn_build(&app.state);
            eprintln!("local-search: config changed, rebuilding index");
        }
    }
}

fn fs_mtime(path: &std::path::Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn handle_search(app: &mut App, args: &Value) -> Result<Value, String> {
    reload_config_if_changed(app);
    let text = args
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let limit_arg = args.get("limit").and_then(|v| v.as_u64()).map(|v| v as u32);
    let max = app.state.config.lock().unwrap().max_results;
    let limit = limit_arg.unwrap_or(max).min(max).clamp(1, 200) as usize;
    let parsed = search::parse(&text);

    let (indices, total, done) = app.state.snapshot();
    // 盘符过滤:限定盘还没建完就只回进度,避免误以为"搜不到"。
    let indices: Vec<_> = match &parsed.drive {
        Some(d) => {
            let want = d.to_lowercase();
            indices
                .into_iter()
                .filter(|i| i.drive[..1].to_lowercase() == *want)
                .collect()
        }
        None => indices,
    };
    let drive_ready = parsed.drive.is_none() || !indices.is_empty();

    let mut hits = Vec::new();
    // 有关键词正常搜;没关键词但带扩展名(如 ".pdf")= 浏览该类型全部文件;
    // 两者都没有(空查询/仅盘符)不搜,回空结果由页面展示引导。
    let searchable = parsed.has_terms || parsed.ext.is_some();
    if drive_ready && searchable && !indices.is_empty() {
        for hit in search::search_parallel(&indices, &parsed, limit) {
            hits.push(json!({
                // 目录的内部表示带尾部 `\`,对外统一去掉,目录属性由 is_dir 表达。
                "path": hit.path.trim_end_matches('\\'),
                "name": hit.name,
                "dir": hit.subtitle,
                "is_dir": hit.is_dir,
                "score": hit.score,
                "highlight": hit.highlight,
            }));
        }
    }
    let files = app.state.indexed_file_count();
    let pending = app.state.pending_letters();
    Ok(json!({
        "text": text,
        "hits": hits,
        // 无关键词且无扩展名(如仅 "d:"):页面据此展示引导而非「未找到」
        "filter_only": !parsed.has_terms && parsed.ext.is_none(),
        "progress": {
            "total": total,
            "done": done,
            "files": files,
            "visited": app.state.visited_total(),
            // 上次全量扫描的条目总数:页面拿 visited/est_total 算平滑百分比
            "est_total": app.state.est_total.load(Ordering::Relaxed),
            "pending": pending,
            "drive_ready": drive_ready,
        },
    }))
}

fn get_config(app: &mut App) -> Result<Value, String> {
    let letters = config::enumerate_drive_letters();
    let path = config::ensure_exists(&letters);
    app.config_path = path.clone();
    let cfg = app.state.config.lock().unwrap().clone();
    Ok(json!({
        "config": cfg,
        "letters": letters,
        "path": path,
    }))
}

fn set_config(app: &mut App, args: &Value) -> Result<Value, String> {
    let cfg: config::Config = serde_json::from_value(
        args.get("config").cloned().unwrap_or(Value::Null),
    )
    .map_err(|e| format!("配置格式有误:{e}"))?;
    // 落盘 → 热更新内存 → 重建索引(与"外部改文件 + 热重载"同一条链路)。
    if let Some(parent) = app.config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败:{e}"))?;
    }
    let text = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&app.config_path, text).map_err(|e| format!("写配置文件失败:{e}"))?;
    app.config_mtime = fs_mtime(&app.config_path);
    *app.state.config.lock().unwrap() = cfg;
    index::spawn_build(&app.state);
    eprintln!("local-search: config saved, rebuilding index");
    Ok(json!({ "ok": true }))
}