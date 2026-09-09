//! Spark native 插件「Hosts切换」入口:多套 hosts 方案合并写入系统 hosts。
//!
//! 生命周期(纯应用模型):用户打开插件页面 → 页面首次 `spark.rpc` 时 host 才
//! spawn 本进程;关闭页面 → `plugin.shutdown` → 进程回收。所有方案/公共配置
//! 存插件数据目录 config.json,系统 hosts 只在「应用」时被整文件重写(先备份)。

mod config;
mod hosts;
mod proto;

use config::{Backup, Config, Scheme};
use proto::{err_response, ok_response, value_or_err, PluginPageParams, RpcRequest};
use serde_json::{json, Value};
use std::io::{self, Write};
use std::path::PathBuf;

const PLUGIN_ID: &str = "com.spark.hosts-switcher";
const SDK_VERSION: &str = "hosts-switcher-0.1.0";
/// 公共配置备份最多保留条数(超出删最旧条目及其文件)。
const MAX_BACKUPS: usize = 20;

struct App {
    cfg: Config,
    hosts_path: PathBuf,
}

fn main() {
    let hosts_path = hosts::hosts_path();
    let (cfg, seeded) = config::load_or_seed(&hosts_path);
    if seeded {
        eprintln!("hosts-switcher: 首次初始化,已读系统 hosts 作为公共配置");
    }
    let mut app = App {
        cfg,
        hosts_path,
    };

    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut stdout = io::stdout().lock();

    loop {
        let body = match proto::read_frame(&mut reader) {
            Ok(Some(b)) => b,
            Ok(None) => break, // host 关闭管道:退出
            Err(e) => {
                eprintln!("hosts-switcher: read frame failed: {e}");
                break;
            }
        };
        let req: RpcRequest = match serde_json::from_slice(&body) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("hosts-switcher: bad rpc request: {e}");
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
                eprintln!("hosts-switcher: unknown method {other}");
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
        "get_state" => get_state(app),
        "set_base" => set_base(app, args),
        "create_scheme" => create_scheme(app, args),
        "update_scheme" => update_scheme(app, args),
        "delete_scheme" => delete_scheme(app, args),
        "set_active" => set_active(app, args),
        "preview" => preview(app, args),
        "apply" => apply(app, args),
        "flush_dns" => hosts::flush_dns().map(|_| json!({ "ok": true })),
        "reveal_hosts" => {
            hosts::reveal(&app.hosts_path);
            Ok(json!({ "ok": true }))
        }
        "export_base" => export_base(app, args),
        "delete_backup" => delete_backup(app, args),
        other => Err(format!("未知方法:{other}")),
    }
}

fn selected_pairs(cfg: &Config, ids: &[Value]) -> Vec<(String, String)> {
    ids.iter()
        .filter_map(|v| v.as_str())
        .filter_map(|id| cfg.schemes.iter().find(|s| s.id == id))
        .map(|s| (s.name.clone(), s.content.clone()))
        .collect()
}

/// 页面勾选状态:排除已删除的方案 id,保持页面给出的顺序。
fn normalize_active(cfg: &mut Config, ids: &[Value]) {
    cfg.active_ids = ids
        .iter()
        .filter_map(|v| v.as_str())
        .filter(|id| cfg.schemes.iter().any(|s| &s.id == id))
        .map(|s| s.to_string())
        .collect();
}

fn get_state(app: &mut App) -> Result<Value, String> {
    let readable = std::fs::metadata(&app.hosts_path).is_ok();
    let current = if readable {
        hosts::read_hosts(&app.hosts_path).unwrap_or_default()
    } else {
        String::new()
    };
    // external_changed:插件写过且当前内容与写入时不一致 → hosts 被外部改动过
    let external_changed = app.cfg.last_applied_hash != 0
        && hosts::fnv1a(&current) != app.cfg.last_applied_hash;
    Ok(json!({
        "hosts_path": app.hosts_path.display().to_string(),
        "writable": hosts::is_writable(&app.hosts_path),
        "readable": readable,
        "current": current,
        "base": app.cfg.base,
        "base_seeded": app.cfg.base_seeded,
        "schemes": app.cfg.schemes,
        "backups": app.cfg.backups,
        "active_ids": app.cfg.active_ids,
        "last_applied_ms": app.cfg.last_applied_ms,
        "last_applied_ids": app.cfg.last_applied_ids,
        "external_changed": external_changed,
    }))
}

fn set_base(app: &mut App, args: &Value) -> Result<Value, String> {
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or("缺少 content")?;
    app.cfg.base = content.to_string();
    config::save(&app.cfg);
    Ok(json!({ "ok": true }))
}

fn create_scheme(app: &mut App, args: &Value) -> Result<Value, String> {
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("方案名不能为空")?
        .to_string();
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let now = config::now_ms_pub();
    let scheme = Scheme {
        id: config::new_id("s-"),
        name,
        content,
        created_ms: now,
        updated_ms: now,
    };
    app.cfg.schemes.push(scheme.clone());
    config::save(&app.cfg);
    Ok(json!(scheme))
}

fn update_scheme(app: &mut App, args: &Value) -> Result<Value, String> {
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("缺少 id")?;
    let scheme = app
        .cfg
        .schemes
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or("方案不存在")?;
    if let Some(name) = args.get("name").and_then(|v| v.as_str()) {
        let name = name.trim();
        if name.is_empty() {
            return Err("方案名不能为空".into());
        }
        scheme.name = name.to_string();
    }
    if let Some(content) = args.get("content").and_then(|v| v.as_str()) {
        scheme.content = content.to_string();
    }
    scheme.updated_ms = config::now_ms_pub();
    let out = scheme.clone();
    config::save(&app.cfg);
    Ok(json!(out))
}

fn delete_scheme(app: &mut App, args: &Value) -> Result<Value, String> {
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("缺少 id")?;
    let before = app.cfg.schemes.len();
    app.cfg.schemes.retain(|s| s.id != id);
    if app.cfg.schemes.len() == before {
        return Err("方案不存在".into());
    }
    app.cfg.active_ids.retain(|x| x != id);
    app.cfg.last_applied_ids.retain(|x| x != id);
    config::save(&app.cfg);
    Ok(json!({ "ok": true }))
}

fn set_active(app: &mut App, args: &Value) -> Result<Value, String> {
    let ids = args.get("ids").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    normalize_active(&mut app.cfg, &ids);
    config::save(&app.cfg);
    Ok(json!({ "ok": true, "active_ids": app.cfg.active_ids }))
}

fn preview(app: &mut App, args: &Value) -> Result<Value, String> {
    let ids = args.get("ids").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let pairs = selected_pairs(&app.cfg, &ids);
    Ok(json!({ "merged": hosts::merge(&app.cfg.base, &pairs) }))
}

/// 应用:合并(公共配置 + 选中方案)→ 备份 → 整文件重写 → 刷新系统 DNS 缓存。
/// DNS 刷新是尽力而为:失败不阻断写入成功,失败原因回传页面提示。
fn apply(app: &mut App, args: &Value) -> Result<Value, String> {
    let ids = args.get("ids").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let pairs = selected_pairs(&app.cfg, &ids);
    let merged = hosts::merge(&app.cfg.base, &pairs);
    hosts::write_hosts(&app.hosts_path, &merged)?;

    normalize_active(&mut app.cfg, &ids);
    app.cfg.last_applied_ms = config::now_ms_pub();
    app.cfg.last_applied_ids = app.cfg.active_ids.clone();
    app.cfg.last_applied_hash = hosts::fnv1a(&merged);
    config::save(&app.cfg);

    let flushed = hosts::flush_dns().is_ok();
    Ok(json!({
        "ok": true,
        "bytes": merged.len(),
        "schemes": pairs.len(),
        "flushed": flushed,
        "applied_ms": app.cfg.last_applied_ms,
    }))
}

/// 备份公共配置:纯文本落到**插件安装目录下的 backups/**(args.dir 供冒烟测试重定向,
/// args.content 允许页面备份编辑器里的未保存内容),同时把条目记入 config(列表里可见,
/// 上限 MAX_BACKUPS 条,超出删最旧条目及其文件)。不弹资源管理器,备份在列表里可见即可。
fn export_base(app: &mut App, args: &Value) -> Result<Value, String> {
    let content = match args.get("content").and_then(|v| v.as_str()) {
        Some(c) => c.to_string(),
        None => app.cfg.base.clone(),
    };
    let dir = match args.get("dir").and_then(|v| v.as_str()) {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => hosts::plugin_backup_dir(),
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return Err(format!("创建备份目录失败:{e}"));
    }
    let stamp = hosts::local_stamp();
    // 同一秒内连续两次备份会撞名覆盖(两条 config 记录指向同一文件,误删连带),追加序号保证文件唯一
    let mut seq = 0u32;
    let (_file_name, path) = loop {
        let name = if seq == 0 {
            format!("hosts-公共配置-{stamp}.txt")
        } else {
            format!("hosts-公共配置-{stamp}-{seq}.txt")
        };
        let p = dir.join(&name);
        if !p.exists() {
            break (name, p);
        }
        seq += 1;
    };
    std::fs::write(&path, &content).map_err(|e| format!("写备份文件失败:{e}"))?;

    let backup = Backup {
        id: config::new_id("b-"),
        name: stamp.clone(),
        content,
        // 存绝对路径:delete_backup 不依赖默认目录(冒烟的 dir 重定向也能删对文件)
        file: path.display().to_string(),
        created_ms: config::now_ms_pub(),
    };
    app.cfg.backups.push(backup.clone());
    while app.cfg.backups.len() > MAX_BACKUPS {
        let old = app.cfg.backups.remove(0);
        if !old.file.is_empty() {
            let _ = std::fs::remove_file(&old.file);
        }
    }
    config::save(&app.cfg);
    Ok(json!({ "ok": true, "path": path.display().to_string(), "backup": backup }))
}

/// 删除备份条目并尽力删除插件目录下的备份文件。
fn delete_backup(app: &mut App, args: &Value) -> Result<Value, String> {
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("缺少 id")?;
    let pos = app
        .cfg
        .backups
        .iter()
        .position(|b| b.id == id)
        .ok_or("备份不存在")?;
    let backup = app.cfg.backups.remove(pos);
    if !backup.file.is_empty() {
        let _ = std::fs::remove_file(&backup.file);
    }
    config::save(&app.cfg);
    Ok(json!({ "ok": true }))
}