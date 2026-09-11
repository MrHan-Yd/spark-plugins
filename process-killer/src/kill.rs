//! 结束进程:温和(`taskkill` 不带 /F,向 GUI 程序发 WM_CLOSE)/ 强杀(`TerminateProcess`)。
//! 保护名单内的系统关键进程(csrs/lsass 一类,杀之即蓝屏)无条件拒绝。

use serde_json::{json, Value};
use std::time::Duration;

/// 保护名单:按归一化进程名(小写、去 .exe)比对,结束会导致系统崩溃的一类。
pub const PROTECTED: [&str; 8] = [
    "csrss",
    "smss",
    "wininit",
    "winlogon",
    "lsass",
    "services",
    "registry",
    "memory compression",
];

/// 进程名归一化:小写、去 .exe 后缀,用于保护名单比对。
fn norm_name(name: &str) -> String {
    let n = name.trim().to_lowercase();
    n.strip_suffix(".exe").map(str::to_string).unwrap_or(n)
}

/// 硬性拒绝项:本插件自身、pid 0/4(System/Idle)、保护名单。
fn guards(pid: u32, name: &str) -> Result<(), String> {
    if pid == std::process::id() {
        return Err("拒绝结束:这是本插件自己的进程".into());
    }
    if pid == 0 || pid == 4 {
        return Err("拒绝结束:系统关键进程(System/Idle)".into());
    }
    let n = norm_name(name);
    if !n.is_empty() && PROTECTED.contains(&n.as_str()) {
        return Err(format!(
            "拒绝结束:系统关键进程 {name}(结束会导致系统崩溃)"
        ));
    }
    Ok(())
}

#[cfg(windows)]
pub fn kill(pid: u32, name: &str, graceful: bool) -> Result<Value, String> {
    guards(pid, name)?;
    if !alive(pid) {
        return Ok(json!({ "ok": true, "exited": true, "detail": "进程已退出" }));
    }
    if graceful {
        // 温和关闭对无窗口进程/服务天然可能发不出(甚至 taskkill 直接失败),
        // 这不是错误——返回 exited:false,由页面追问「改用强杀」
        let (exited, detail) = match taskkill_graceful(pid) {
            Ok(_) => {
                std::thread::sleep(Duration::from_millis(1500));
                let exited = alive(pid);
                let detail = if exited {
                    "进程已退出".to_string()
                } else {
                    "已发送关闭请求,进程未退出(可能弹了保存窗口,或属于无窗口程序)".to_string()
                };
                (exited, detail)
            }
            Err(_send_err) => {
                if !alive(pid) {
                    (true, "进程已退出".to_string())
                } else {
                    (false, "未能发送关闭请求(进程可能以管理员运行或无窗口);可改用强杀".to_string())
                }
            }
        };
        return Ok(json!({ "ok": true, "exited": exited, "detail": detail }));
    }
    force_kill(pid)
}

#[cfg(not(windows))]
pub fn kill(_pid: u32, _name: &str, _graceful: bool) -> Result<Value, String> {
    Err("仅支持 Windows".into())
}

#[cfg(windows)]
pub fn alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED | SYNCHRONIZE, 0, pid);
        if h.is_null() {
            // 打不开但拒绝的是「无权限」而非「不存在」 → 进程还在
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let running = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
        CloseHandle(h);
        running
    }
}

#[cfg(not(windows))]
pub fn alive(_pid: u32) -> bool {
    false
}

/// 温和结束:taskkill 不带 /F(对无窗口进程/服务无效,失败时把系统报错透传)。
#[cfg(windows)]
fn taskkill_graceful(pid: u32) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("启动 taskkill 失败:{e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!(
            "taskkill:{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// 强杀:TerminateProcess + 等待退出确认,错误码映射成人话。
#[cfg(windows)]
fn force_kill(pid: u32) -> Result<Value, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, WaitForSingleObject};
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, 0, pid);
        if h.is_null() {
            let e = GetLastError();
            return Err(if e == ERROR_ACCESS_DENIED {
                "权限不足:目标进程可能以管理员运行,当前宿主无权结束".into()
            } else if e == ERROR_INVALID_PARAMETER {
                "进程不存在(可能刚退出)".into()
            } else {
                format!("打开进程失败(Windows 错误码 {e})")
            });
        }
        if TerminateProcess(h, 1) == 0 {
            let e = GetLastError();
            CloseHandle(h);
            return Err(format!("终止进程失败(Windows 错误码 {e})"));
        }
        let exited = WaitForSingleObject(h, 1500) == WAIT_OBJECT_0;
        CloseHandle(h);
        Ok(json!({
            "ok": true,
            "exited": exited,
            "detail": if exited { "已结束".to_string() } else { "已发送强杀,进程暂未退出".to_string() },
        }))
    }
}

const PROCESS_TERMINATE: u32 = 0x0001;
const SYNCHRONIZE: u32 = 0x0010_0000;
const PROCESS_QUERY_LIMITED: u32 = 0x1000;
const WAIT_OBJECT_0: u32 = 0;
const WAIT_TIMEOUT: u32 = 0x102;
const ERROR_ACCESS_DENIED: u32 = 5;
const ERROR_INVALID_PARAMETER: u32 = 87;