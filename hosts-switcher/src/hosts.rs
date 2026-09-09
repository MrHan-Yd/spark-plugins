//! 系统 hosts 文件:路径解析、读取、合并、备份写入、可写性探测、DNS 缓存刷新。
//!
//! 写入策略:整文件重写(公共配置 + 选中方案合并结果),写前把当前内容备份到
//! 同目录 `hosts.spark-backup`(尽力而为)。hosts 通常需要管理员或显式授权才可写,
//! PermissionDenied 会转成带自救指引的错误消息回给页面。

use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 系统 hosts 路径:`%SystemRoot%\System32\drivers\etc\hosts`。
/// 环境变量 `SPARK_HOSTS_PATH` 可重定向(仅供冒烟测试,发布链路不要设置)。
pub fn hosts_path() -> PathBuf {
    if let Ok(p) = std::env::var("SPARK_HOSTS_PATH") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    Path::new(&root)
        .join("System32")
        .join("drivers")
        .join("etc")
        .join("hosts")
}

fn friendly_io(e: &std::io::Error, what: &str) -> String {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => format!(
            "{}失败:hosts 文件不可写。请查看 hosts 文件属性,取消「只读」;\
或在其「安全」标签 →「编辑」中为当前登录用户勾选「写入」(详见页面右上角「帮助」)",
            what
        ),
        std::io::ErrorKind::NotFound => format!("{}失败:未找到系统 hosts 文件", what),
        _ => format!("{}失败:{e}", what),
    }
}

/// 读 hosts(字节按 UTF-8 宽松解码;hosts 内容正常为 ASCII,不受影响)。
pub fn read_hosts(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| friendly_io(&e, "读 hosts"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// 试探当前用户能否写 hosts:以追加模式打开一次即验证,不改动内容。
pub fn is_writable(path: &Path) -> bool {
    OpenOptions::new().append(true).open(path).is_ok()
}

/// 备份文件路径:与 hosts 同目录,固定名,不覆盖别的工具的 hosts.bak。
pub fn backup_path(hosts: &Path) -> PathBuf {
    hosts
        .with_file_name("hosts.spark-backup")
}

/// 写 hosts:先备份当前内容(尽力而为),再整文件重写。
pub fn write_hosts(path: &Path, content: &str) -> Result<(), String> {
    if let Ok(prev) = std::fs::read(path) {
        let _ = std::fs::write(backup_path(path), prev);
    }
    std::fs::write(path, content).map_err(|e| friendly_io(&e, "写 hosts"))
}

/// 换行统一为 Windows 惯例 CRLF(记事本直接打开不串行)。
fn normalize_newlines(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push_str("\r\n");
        } else if c == '\n' {
            out.push_str("\r\n");
        } else {
            out.push(c);
        }
    }
    out
}

fn ensure_trailing_newline(s: &mut String) {
    if !s.ends_with('\n') {
        s.push_str("\r\n");
    }
}

/// 合并:公共配置在前,每个选中方案追加一个注释标记段,顺序即传入顺序。
/// 整段原文保留(不解析、不排序、不去重——hosts 语义由用户自己负责)。
pub fn merge(base: &str, selected: &[(String, String)]) -> String {
    let mut out = normalize_newlines(base);
    ensure_trailing_newline(&mut out);
    for (name, content) in selected {
        out.push_str(&format!("\r\n# ==== Hosts切换 方案: {} ====\r\n", name));
        let mut body = normalize_newlines(content);
        ensure_trailing_newline(&mut body);
        out.push_str(&body);
    }
    out
}

/// FNV-1a 64:检测 hosts 是否在插件外被改动(非加密用途,不引依赖)。
pub fn fnv1a(data: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in data.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// 刷新系统 DNS 缓存(ipconfig /flushdns)。浏览器内部缓存不受此影响,页面帮助里有说明。
pub fn flush_dns() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let out = Command::new("ipconfig")
            .arg("/flushdns")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("启动 ipconfig 失败:{e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "刷新 DNS 缓存失败:{}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

/// 资源管理器定位任意文件(explorer /select)。
pub fn reveal(path: &Path) {
    let _ = Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
}

/// 备份目录:插件安装目录下的 backups/(exe 与 plugin.json 同目录,重装插件会随目录更新)。
pub fn plugin_backup_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            return dir.join("backups");
        }
    }
    PathBuf::from("backups")
}

/// 本地时间戳 YYYYMMDD-HHMMSS(kernel32 直连,不引依赖)。
pub fn local_stamp() -> String {
    #[cfg(windows)]
    {
        #[repr(C)]
        struct SystemTime {
            year: u16,
            month: u16,
            day_of_week: u16,
            day: u16,
            hour: u16,
            minute: u16,
            second: u16,
            millis: u16,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetLocalTime(lpSystemTime: *mut SystemTime) -> i32;
        }
        let mut st = SystemTime { year: 0, month: 0, day_of_week: 0, day: 0, hour: 0, minute: 0, second: 0, millis: 0 };
        unsafe { GetLocalTime(&mut st) };
        format!(
            "{:04}{:02}{:02}-{:02}{:02}{:02}",
            st.year, st.month, st.day, st.hour, st.minute, st.second
        )
    }
    #[cfg(not(windows))]
    {
        "backup".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_base_and_marks_schemes() {
        let merged = merge(
            "# base\n127.0.0.1 localhost\n",
            &[
                ("开发".into(), "10.0.0.1 dev.example.com\n".into()),
                ("测试".into(), "10.0.0.2 test.example.com".into()),
            ],
        );
        assert!(merged.starts_with("# base\r\n127.0.0.1 localhost\r\n"));
        assert!(merged.contains("# ==== Hosts切换 方案: 开发 ====\r\n10.0.0.1 dev.example.com\r\n"));
        // 尾行无换行的方案也要补齐,避免下一段标记贴在同一行
        assert!(merged.contains("# ==== Hosts切换 方案: 测试 ====\r\n10.0.0.2 test.example.com\r\n"));
        assert!(merged.ends_with("\r\n"));
    }

    #[test]
    fn merge_empty_selection_is_base_only() {
        let merged = merge("# only base", &[]);
        assert_eq!(merged, "# only base\r\n");
    }

    #[test]
    fn normalize_mixed_newlines() {
        assert_eq!(normalize_newlines("a\nb\r\nc\rd"), "a\r\nb\r\nc\r\nd");
    }

    #[test]
    fn fnv1a_stable() {
        assert_eq!(fnv1a("abc"), fnv1a("abc"));
        assert_ne!(fnv1a("abc"), fnv1a("abd"));
    }
}