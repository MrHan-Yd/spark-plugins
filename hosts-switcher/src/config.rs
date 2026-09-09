//! 插件配置:`%APPDATA%\Spark\plugins-data\com.spark.hosts-switcher\config.json`。
//!
//! 首次使用(配置不存在/损坏)时读系统现有 hosts 作为公共配置(base),
//! 方案列表为空。环境变量 `SPARK_HOSTS_CONFIG` 可重定向配置路径(仅供冒烟测试)。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const PLUGIN_ID: &str = "com.spark.hosts-switcher";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scheme {
    pub id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub created_ms: u64,
    #[serde(default)]
    pub updated_ms: u64,
}

/// 公共配置备份条目:列表里像方案一样可见,内容只读;同时落盘到插件目录 backups/。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Backup {
    pub id: String,
    pub name: String,
    pub content: String,
    /// 备份文件绝对路径(插件目录 backups/ 下),删除条目时连带删文件。
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub created_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// 公共配置:首次初始化 = 系统 hosts 原文;之后独立于系统文件在插件内维护。
    pub base: String,
    /// base 是否真的来自系统 hosts(读到失败时用占位注释,界面提示用户粘贴)。
    #[serde(default)]
    pub base_seeded: bool,
    #[serde(default)]
    pub schemes: Vec<Scheme>,
    /// 公共配置备份条目(最近 20 条,文件在插件目录 backups/)。
    #[serde(default)]
    pub backups: Vec<Backup>,
    /// 页面当前勾选(未 necessarily 已写入)。
    #[serde(default)]
    pub active_ids: Vec<String>,
    #[serde(default)]
    pub last_applied_ms: u64,
    #[serde(default)]
    pub last_applied_ids: Vec<String>,
    /// 上次成功写入 hosts 的合并内容 FNV-1a(0 = 尚未用本插件写过)。
    #[serde(default)]
    pub last_applied_hash: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn new_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}{:x}-{:x}", now_ms(), n as u64 | ((std::process::id() as u64) << 32))
}

pub fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("SPARK_HOSTS_CONFIG") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    Path::new(&base)
        .join("Spark")
        .join("plugins-data")
        .join(PLUGIN_ID)
        .join("config.json")
}

fn default_base() -> String {
    "# Hosts 公共配置\n# (首次初始化时未能读取系统 hosts,可在此粘贴原 hosts 内容)\n".to_string()
}

/// 读配置;首次/损坏时初始化:公共配置 = 系统 hosts 原文,并落盘。
/// 返回 (配置, 本次是否为首次初始化)。
pub fn load_or_seed(hosts: &Path) -> (Config, bool) {
    if let Ok(text) = fs::read_to_string(config_path()) {
        if let Ok(cfg) = serde_json::from_str::<Config>(&text) {
            return (cfg, false);
        }
        eprintln!("hosts-switcher: config.json 损坏,已按首次初始化重建");
    }
    let (base, seeded) = match fs::read(hosts) {
        Ok(bytes) => (String::from_utf8_lossy(&bytes).into_owned(), true),
        Err(_) => (default_base(), false),
    };
    let cfg = Config {
        base,
        base_seeded: seeded,
        schemes: Vec::new(),
        backups: Vec::new(),
        active_ids: Vec::new(),
        last_applied_ms: 0,
        last_applied_ids: Vec::new(),
        last_applied_hash: 0,
    };
    save(&cfg);
    (cfg, true)
}

pub fn save(cfg: &Config) {
    let path = config_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(cfg) {
        Ok(json) => {
            if let Err(e) = fs::write(&path, json) {
                eprintln!("hosts-switcher: 写配置失败:{e}");
            }
        }
        Err(e) => eprintln!("hosts-switcher: 序列化配置失败:{e}"),
    }
}

pub fn now_ms_pub() -> u64 {
    now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_ids_unique() {
        let a = new_id("s-");
        let b = new_id("s-");
        let c = new_id("b-");
        assert_ne!(a, b);
        assert!(a.starts_with("s-"));
        assert!(c.starts_with("b-"));
    }

    #[test]
    fn config_roundtrip() {
        let cfg = Config {
            base: "# x".into(),
            base_seeded: true,
            schemes: vec![Scheme {
                id: new_id("s-"),
                name: "开发".into(),
                content: "10.0.0.1 dev".into(),
                created_ms: 1,
                updated_ms: 2,
            }],
            backups: vec![Backup {
                id: new_id("b-"),
                name: "20260909-154630".into(),
                content: "# base".into(),
                file: "hosts-公共配置-20260909-154630.txt".into(),
                created_ms: 3,
            }],
            active_ids: vec!["s-1".into()],
            last_applied_ms: 3,
            last_applied_ids: vec!["s-1".into()],
            last_applied_hash: 42,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: Config = serde_json::from_str(&json).unwrap();
        assert_eq!(back.schemes[0].name, "开发");
        assert_eq!(back.backups[0].file, "hosts-公共配置-20260909-154630.txt");
        assert_eq!(back.last_applied_hash, 42);
    }
}