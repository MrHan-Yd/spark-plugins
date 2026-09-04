//! 插件配置:`%APPDATA%\Spark\plugins-data\com.spark.local-search\config.json`。
//!
//! 生成策略:所有存在的固定/可移动盘符**默认全部 true**(默认选,用户自己 x 掉另算)。
//! 配置放 Spark 数据目录而不是插件目录,重装插件不丢。文件改动(mtime)在下一次
//! 查询时被检测并触发热重建。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const PLUGIN_ID: &str = "com.spark.local-search";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// 参与索引的盘符 -> 是否索引。键缺省视为 true(新接入的盘自动纳入)。
    #[serde(default)]
    pub drives: BTreeMap<String, bool>,
    /// 跳过的目录名(不区分大小写,匹配任意层级)。
    #[serde(default = "default_exclude_dirs")]
    pub exclude_dirs: Vec<String>,
    /// 单次查询返回上限(host `limit` 与它的较小者生效)。
    #[serde(default = "default_max_results")]
    pub max_results: u32,
}

fn default_exclude_dirs() -> Vec<String> {
    [
        "windows",
        "program files",
        "program files (x86)",
        "programdata",
        "appdata",
        "system volume information",
        "$recycle.bin",
        "node_modules",
        ".git",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn default_max_results() -> u32 {
    50
}

/// 配置文件路径:`<APPDATA>\Spark\plugins-data\<id>\config.json`。
pub fn config_path() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    Path::new(&base)
        .join("Spark")
        .join("plugins-data")
        .join(PLUGIN_ID)
        .join("config.json")
}

/// 生成默认枚举的盘符集合(存在即纳入,默认全选)。
pub fn enumerate_drive_letters() -> Vec<String> {
    let mut letters = Vec::new();
    for c in b'A'..=b'Z' {
        let root = format!("{}:\\", c as char);
        if fs::metadata(&root).map(|m| m.is_dir()).unwrap_or(false) {
            letters.push(format!("{}:", c as char));
        }
    }
    letters
}

/// 读配置;不存在/损坏时用"全部盘符默认 true"生成一份再读。
/// 返回 (路径, 配置, mtime 基线)。
pub fn ensure_and_load(letters: &[String]) -> (PathBuf, Config, Option<std::time::SystemTime>) {
    let path = config_path();
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<Config>(&text) {
            let mtime = fs::metadata(&path).and_then(|m| m.modified()).ok();
            return (path, cfg, mtime);
        }
    }
    let mut drives = BTreeMap::new();
    for l in letters {
        drives.insert(l.clone(), true);
    }
    let cfg = Config {
        drives,
        exclude_dirs: default_exclude_dirs(),
        max_results: default_max_results(),
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&cfg) {
        let _ = fs::write(&path, json);
    }
    let mtime = fs::metadata(&path).and_then(|m| m.modified()).ok();
    (path, cfg, mtime)
}

/// 生成(或补写)配置文件,供"打开配置"动作在文件被删后恢复。
pub fn ensure_exists(letters: &[String]) -> PathBuf {
    let path = config_path();
    if path.is_file() {
        return path;
    }
    let mut drives = BTreeMap::new();
    for l in letters {
        drives.insert(l.clone(), true);
    }
    let cfg = Config {
        drives,
        exclude_dirs: default_exclude_dirs(),
        max_results: default_max_results(),
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&cfg) {
        let _ = fs::write(&path, json);
    }
    path
}

/// 生效盘符:枚举到的盘里,配置未显式标 false 的都索引。
pub fn effective_letters(cfg: &Config) -> Vec<String> {
    enumerate_drive_letters()
        .into_iter()
        .filter(|l| cfg.drives.get(l) != Some(&false))
        .collect()
}

/// 索引进度校准文件(与 config.json 同目录):记录上次全量扫描的条目总数,
/// 重建时用作进度百分比的分母——全盘有多少条目只有扫完才知道,只能拿上次校准。
/// 首次没有基线 → 页面退化为流动动画。
pub fn index_meta_path() -> PathBuf {
    let mut p = config_path();
    p.set_file_name("index-meta.json");
    p
}

pub fn load_last_visited() -> Option<u64> {
    let text = fs::read_to_string(index_meta_path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("visited_total").and_then(|x| x.as_u64())
}

pub fn save_last_visited(visited: u64) {
    let path = index_meta_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = serde_json::json!({ "visited_total": visited });
    let _ = fs::write(&path, serde_json::to_string(&json).unwrap_or_default());
}