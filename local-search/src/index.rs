//! 文件名内存索引:每盘一棵目录树,盘间 + 盘内(一级子目录子树)并行构建,
//! 单盘建完即可被搜到。
//!
//! 并行策略:每盘一个「装配线程」扫盘根(轻量),把一级子目录整棵子树拆成任务,
//! 交给全局 worker 池并行遍历——元数据 IO 吃并行度,单线程逐目录走是主要瓶颈。
//! 索引只存在于插件进程内存,不落盘:进程退出即整体释放,磁盘零残留。
//! 重建以 `generation` 计数,旧代次线程的发布一律丢弃。

use crate::config::{self, Config};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

/// 目录树节点。`name` 为目录名(根节点为空串),文件名存叶子。
#[derive(Default)]
pub struct DirNode {
    pub name: String,
    pub dirs: Vec<DirNode>,
    pub files: Vec<String>,
}

pub struct DriveIndex {
    /// 如 "C:"。
    pub drive: String,
    /// 根节点(对应 `<盘>:\`),`root.name` 为空。
    pub root: DirNode,
    pub file_count: u64,
}

pub struct Slot {
    pub letter: String,
    pub index: Option<Arc<DriveIndex>>,
}

pub struct State {
    pub config: Mutex<Config>,
    pub slots: Mutex<Vec<Slot>>,
    /// 构建代次:配置热重载时 +1,旧代次线程的发布会被丢弃。
    pub generation: AtomicU64,
    /// 每盘遍历条目计数(页面进度展示用);重建时清空重登记,
    /// 旧代次线程的计数器随移除失效,不会计入 visited_total。
    pub visited: Mutex<Vec<(String, Arc<AtomicU64>)>>,
    /// 上次全量扫描的条目总数(进度百分比的校准分母;无基线为 0)。
    pub est_total: AtomicU64,
}

impl State {
    pub fn new(cfg: Config) -> Arc<State> {
        let letters = config::effective_letters(&cfg);
        let slots = letters
            .into_iter()
            .map(|letter| Slot { letter, index: None })
            .collect();
        Arc::new(State {
            config: Mutex::new(cfg),
            slots: Mutex::new(slots),
            generation: AtomicU64::new(0),
            visited: Mutex::new(Vec::new()),
            est_total: AtomicU64::new(config::load_last_visited().unwrap_or(0)),
        })
    }

    /// 全部盘已扫描条目总数(遍历进行中实时增长,进度展示用)。
    pub fn visited_total(&self) -> u64 {
        self.visited
            .lock()
            .unwrap()
            .iter()
            .map(|(_, c)| c.load(Ordering::Relaxed))
            .sum()
    }

    /// 已就绪盘的快照 + (总盘数, 完成盘数)。Arc 克隆在锁内完成,搜索在锁外。
    pub fn snapshot(&self) -> (Vec<Arc<DriveIndex>>, usize, usize) {
        let g = self.slots.lock().unwrap();
        let indices = g.iter().filter_map(|s| s.index.clone()).collect();
        let total = g.len();
        let done = g.iter().filter(|s| s.index.is_some()).count();
        (indices, total, done)
    }

    /// 还在建的盘符列表(展示进度用)。
    pub fn pending_letters(&self) -> Vec<String> {
        self.slots
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.index.is_none())
            .map(|s| s.letter.clone())
            .collect()
    }

    pub fn indexed_file_count(&self) -> u64 {
        self.slots
            .lock()
            .unwrap()
            .iter()
            .filter_map(|s| s.index.as_ref())
            .map(|i| i.file_count)
            .sum()
    }
}

/// 一级子目录子树任务:worker 遍历 `path` 整棵子树,结果按 `idx` 回传装配。
struct WalkTask {
    idx: usize,
    path: PathBuf,
    tx: mpsc::Sender<(usize, DirNode, u64)>,
    visited: Arc<AtomicU64>,
}

/// 后台重建:根扫描(轻) → 一级子目录子树任务入队 → 全局 worker 池并行遍历 → 按代次发布。
pub fn spawn_build(state: &Arc<State>) {
    let letters = {
        let cfg = state.config.lock().unwrap();
        config::effective_letters(&cfg)
    };
    {
        let mut g = state.slots.lock().unwrap();
        *g = letters
            .iter()
            .map(|letter| Slot { letter: letter.clone(), index: None })
            .collect();
    }
    state.visited.lock().unwrap().clear();
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let excludes: Arc<Vec<String>> = Arc::new(state.config.lock().unwrap().exclude_dirs.clone());

    let (task_tx, task_rx) = mpsc::channel::<WalkTask>();
    let task_rx: Arc<Mutex<mpsc::Receiver<WalkTask>>> = Arc::new(Mutex::new(task_rx));

    for (slot, letter) in letters.iter().enumerate() {
        // stderr 心跳:host 不解析 stderr,排查遍历速度用。
        let ticker_st = Arc::clone(state);
        let ticker_letter = letter.clone();
        let _ticker = std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(20));
            let done = ticker_st
                .slots
                .lock()
                .unwrap()
                .iter()
                .any(|s| s.letter == ticker_letter && s.index.is_some());
            if done {
                return;
            }
            eprintln!("local-search: still building {ticker_letter}");
        });

        let visited = Arc::new(AtomicU64::new(0));
        state
            .visited
            .lock()
            .unwrap()
            .push((letter.clone(), Arc::clone(&visited)));

        // 装配线程:扫盘根 → 子树任务入队 → 收齐结果 → 发布该盘
        let st = Arc::clone(state);
        let letter2 = letter.clone();
        let visited2 = Arc::clone(&visited);
        let tx = task_tx.clone();
        let (res_tx, res_rx) = mpsc::channel::<(usize, DirNode, u64)>();
        let spawned = std::thread::Builder::new()
            .name(format!("ls-root-{letter2}"))
            .spawn(move || {
                let excludes = st.config.lock().unwrap().exclude_dirs.clone();
                let mut root = DirNode::default();
                let mut count = 0u64;
                let mut d1: Vec<(String, PathBuf)> = Vec::new();
                let mut batch = 0u64;
                let Ok(rd) = fs::read_dir(Path::new(&format!("{letter2}\\"))) else {
                    publish(&st, slot, &letter2, gen, root, 0);
                    return;
                };
                for entry in rd.flatten() {
                    batch += 1;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let lower = name.to_lowercase();
                    let Ok(ft) = entry.file_type() else { continue };
                    if ft.is_dir() {
                        // 跳过排除目录、`$` 开头目录(回收站等)、联接/符号链接(防环)。
                        if excludes.iter().any(|e| *e == lower)
                            || lower.starts_with('$')
                            || ft.is_symlink()
                            || is_reparse_dir(&entry)
                        {
                            continue;
                        }
                        d1.push((name, entry.path()));
                    } else if ft.is_file() {
                        root.files.push(name);
                        count += 1;
                    }
                }
                visited2.fetch_add(batch, Ordering::Relaxed);

                let n = d1.len();
                for (idx, (_, path)) in d1.iter().enumerate() {
                    let _ = tx.send(WalkTask {
                        idx,
                        path: path.clone(),
                        tx: res_tx.clone(),
                        visited: Arc::clone(&visited2),
                    });
                }
                let mut parts: Vec<Option<DirNode>> = (0..n).map(|_| None).collect();
                let mut got = 0u64;
                while got < n as u64 {
                    match res_rx.recv() {
                        Ok((idx, node, files)) => {
                            parts[idx] = Some(node);
                            count += files;
                            got += 1;
                        }
                        Err(_) => break,
                    }
                }
                root.dirs = parts.into_iter().flatten().collect();
                for (i, node) in root.dirs.iter_mut().enumerate() {
                    node.name = d1[i].0.clone();
                }
                eprintln!("local-search: drive {letter2} indexed, {count} files");
                publish(&st, slot, &letter2, gen, root, count);
            });
        if let Err(e) = spawned {
            eprintln!("local-search: root scanner spawn failed for {letter}: {e}");
        }
    }
    drop(task_tx); // 任务已全部入队;收完后 channel 关闭,worker 自然退出

    // 全局 worker 池:子树并行遍历(元数据 IO 吃并行度,单线程逐目录走是瓶颈)。
    // 池子按核数减半、封顶 8,且整个进程已是「低于正常」优先级——快,但不凶。
    let workers = std::thread::available_parallelism()
        .map(|n| (n.get() / 2).clamp(2, 8))
        .unwrap_or(4);
    for w in 0..workers {
        let rx = Arc::clone(&task_rx);
        let excludes = Arc::clone(&excludes);
        let spawned = std::thread::Builder::new()
            .name(format!("ls-walk-{w}"))
            .spawn(move || loop {
                let task = { rx.lock().unwrap().try_recv() };
                match task {
                    Ok(t) => {
                        let mut node = DirNode::default();
                        let mut count = 0u64;
                        walk(&t.path, &mut node, &excludes, &mut count, &t.visited);
                        let _ = t.tx.send((t.idx, node, count));
                    }
                    Err(_) => break,
                }
            });
        if let Err(e) = spawned {
            eprintln!("local-search: walk worker spawn failed: {e}");
        }
    }

    // 全部盘建完后,把本次扫描总量写进校准文件——下次构建的进度百分比分母。
    let meta_st = Arc::clone(state);
    std::thread::Builder::new()
        .name("ls-meta".to_string())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if meta_st.generation.load(Ordering::SeqCst) != gen {
                return; // 期间又触发了重建,本轮作废,由新一轮的 watcher 接手
            }
            let (_, total, done) = meta_st.snapshot();
            if total > 0 && done == total {
                config::save_last_visited(meta_st.visited_total());
                return;
            }
        })
        .ok();
}

fn publish(st: &Arc<State>, slot: usize, letter: &str, gen: u64, root: DirNode, count: u64) {
    if st.generation.load(Ordering::SeqCst) != gen {
        return; // 已被更新的配置取代,丢弃本代结果
    }
    let mut g = st.slots.lock().unwrap();
    if let Some(s) = g.get_mut(slot) {
        if s.letter == letter {
            s.index = Some(Arc::new(DriveIndex {
                drive: letter.to_string(),
                root,
                file_count: count,
            }));
        }
    }
}

/// Windows 上 Junction 与 symlink 目录都带 reparse point 属性,一律不进入,
/// 防止 `Documents and Settings` 这类联接让遍历绕远/成环。
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

#[cfg(windows)]
fn is_reparse_dir(entry: &fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    entry
        .metadata()
        .map(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .unwrap_or(true) // 元数据读不到 → 保守跳过
}

#[cfg(not(windows))]
fn is_reparse_dir(_entry: &fs::DirEntry) -> bool {
    false
}

/// 遍历 `dir` 整棵子树(顺序深度优先),结果挂到 `node`。
/// `visited` 按目录分帧批量累加,避免每条目一次原子 RMW 的争用。
fn walk(
    dir: &Path,
    node: &mut DirNode,
    excludes: &[String],
    count: &mut u64,
    visited: &AtomicU64,
) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut batch = 0u64;
    for entry in rd.flatten() {
        batch += 1;
        // 轻量限速:每 512 个条目让出 1ms,削平 HDD 上的随机读风暴(I/O 低优先级之外的保险)。
        if batch % 512 == 0 {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_lowercase();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            // 跳过排除目录、`$` 开头目录(回收站等)、联接/符号链接(防环)。
            if excludes.iter().any(|e| *e == lower)
                || lower.starts_with('$')
                || ft.is_symlink()
                || is_reparse_dir(&entry)
            {
                continue;
            }
            let mut child = DirNode {
                name,
                ..Default::default()
            };
            walk(&entry.path(), &mut child, excludes, count, visited);
            node.dirs.push(child);
        } else if ft.is_file() {
            node.files.push(name);
            *count += 1;
        }
    }
    if batch > 0 {
        visited.fetch_add(batch, Ordering::Relaxed);
    }
}