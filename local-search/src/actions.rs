//! 文件动作(页面经 `spark.rpc` 调用):打开 / 打开所在位置 / 复制路径 / 复制文件。
//!
//! Windows 一期唯一目标平台:"打开"用 `explorer.exe`(文件按默认程序/目录直接进),
//! "打开所在位置"用 `explorer /select`;复制走 PowerShell `Set-Clipboard`
//! (copy_file 用 `-LiteralPath`,CF_HDROP 语义)。失败返回 Err,页面 toast 提示。

use crate::index;
use serde_json::{json, Value};
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn spawn_hidden(cmd: &str, args: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    Command::new(cmd)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn spawn_hidden(_cmd: &str, _args: &[&str]) -> Result<(), String> {
    Err("本插件仅支持 Windows".to_string())
}

#[cfg(windows)]
fn powershell_set_clipboard(script: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Set-Clipboard 失败:{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[cfg(not(windows))]
fn powershell_set_clipboard(_script: &str) -> Result<(), String> {
    Err("本插件仅支持 Windows".to_string())
}

/// 单引号字面量转义(PowerShell 内部 `''` 表示一个 `'`)。
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// rpc args 取 path 字段(必填)。
fn arg_path(args: &Value) -> Result<&str, String> {
    args.get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "缺少 path 参数".to_string())
}

/// 目录 / 文件动作统一入口;返回值原样回传页面。
pub fn handle(method: &str, args: &Value, state: &Arc<index::State>) -> Result<Value, String> {
    match method {
        "open" => {
            let p = arg_path(args)?;
            spawn_hidden("explorer", &[p]).map_err(|e| format!("打开失败:{e}"))?;
            Ok(json!({ "ok": true }))
        }
        "reveal" => {
            let p = arg_path(args)?;
            // `/select,<路径>` 对文件和目录语义一致:打开其父级并选中它。
            spawn_hidden("explorer", &[&format!("/select,{p}")])
                .map_err(|e| format!("定位失败:{e}"))?;
            Ok(json!({ "ok": true }))
        }
        "copy_path" => {
            let p = arg_path(args)?;
            let script = format!("Set-Clipboard -Value {}", ps_quote(p));
            powershell_set_clipboard(&script).map_err(|e| format!("复制路径失败:{e}"))?;
            Ok(json!({ "ok": true }))
        }
        "copy_file" => {
            let p = arg_path(args)?;
            if Path::new(p).is_dir() {
                return Err("目录不支持复制文件".to_string());
            }
            let script = format!("Set-Clipboard -LiteralPath {}", ps_quote(p));
            powershell_set_clipboard(&script).map_err(|e| format!("复制文件失败:{e}"))?;
            Ok(json!({ "ok": true }))
        }
        // rebuild 由 main 直接处理(需要 state 的其它部分),这里兜个底。
        _ => {
            let _ = state;
            Err(format!("未知方法:{method}"))
        }
    }
}