//! 冒烟测试:手动以 host 的方式驱动插件协议帧(纯应用模型:`plugin.page` RPC)。
//! 用环境变量把系统 hosts 与配置重定向到临时文件,**全程不碰真实系统 hosts**。
//! 夹具放在 `target/smoke-fixture/`(随 cargo clean 消失),跑前清场、跑完自清,
//! 不在系统临时目录留任何文件。
//! 运行:`cargo run --example smoke`(仅开发用,不进发布物)。

use serde_json::{json, Value};
use std::io::{BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

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

fn main() {
    // 临时 hosts(模拟"系统现有 hosts")+ 临时配置路径;target/ 下的夹具目录,跑前清场跑完自清
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("smoke-fixture");
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::create_dir_all(&dir);
    let tmp_hosts = dir.join("hosts");
    let tmp_cfg = dir.join("config.json");
    std::fs::write(&tmp_hosts, "# smoke seed\n127.0.0.1 localhost\n").unwrap();

    let exe = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/0.1.0/spark-plugin-hosts-switcher.exe"
    );
    let mut child = Command::new(exe)
        .env("SPARK_HOSTS_PATH", &tmp_hosts)
        .env("SPARK_HOSTS_CONFIG", &tmp_cfg)
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
            "params": { "id": "com.spark.hosts-switcher", "permissions": [], "api_version": 1 }
        }),
    );
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        r.pointer("/result/plugin_id").and_then(|v| v.as_str()) == Some("com.spark.hosts-switcher"),
        "initialize 握手",
    );

    // 2) get_state:首次初始化 → 公共配置 = 临时 hosts 原文
    page(&mut input, 2, "get_state", json!({}));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        r.pointer("/result/base").and_then(|v| v.as_str()) == Some("# smoke seed\n127.0.0.1 localhost\n"),
        "首次初始化:公共配置 = 系统 hosts 原文",
    );
    check(
        r.pointer("/result/writable").and_then(|v| v.as_bool()) == Some(true),
        "hosts 可写性探测",
    );
    check(
        r.pointer("/result/schemes").and_then(|v| v.as_array()).map(|a| a.is_empty()).unwrap_or(false),
        "初始方案列表为空",
    );

    // 3) 建两个方案
    page(&mut input, 3, "create_scheme",
        json!({ "name": "开发环境", "content": "10.0.0.1 dev.example.com\n" }));
    let s1 = result_of(&read_frame(&mut output).unwrap());
    let id1 = s1.pointer("/result/id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    check(!id1.is_empty(), "创建方案「开发环境」");

    page(&mut input, 4, "create_scheme",
        json!({ "name": "测试环境", "content": "10.0.0.2 test.example.com" }));
    let s2 = result_of(&read_frame(&mut output).unwrap());
    let id2 = s2.pointer("/result/id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    check(!id2.is_empty(), "创建方案「测试环境」");

    page(&mut input, 5, "create_scheme", json!({ "name": "  ", "content": "" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(r.get("error").is_some(), "空方案名被拒绝");

    // 4) 勾选方案1并应用 → 临时 hosts 应含公共配置 + 方案1,不含方案2
    page(&mut input, 6, "set_active", json!({ "ids": [id1] }));
    let _ = read_frame(&mut output);
    page(&mut input, 7, "apply", json!({ "ids": [id1] }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(r.pointer("/result/ok").and_then(|v| v.as_bool()) == Some(true), "应用(方案1)写入成功");
    let hosts_now = std::fs::read_to_string(&tmp_hosts).unwrap();
    check(hosts_now.contains("127.0.0.1 localhost"), "应用后保留公共配置");
    check(
        hosts_now.contains("# ==== Hosts切换 方案: 开发环境 ====") && hosts_now.contains("10.0.0.1 dev.example.com"),
        "应用后含方案1标记与内容",
    );
    check(!hosts_now.contains("test.example.com"), "未选中的方案2未写入");

    // 5) preview 不落盘
    let before = hosts_now.clone();
    page(&mut input, 8, "preview", json!({ "ids": [id1, id2] }));
    let r = result_of(&read_frame(&mut output).unwrap());
    let merged = r.pointer("/result/merged").and_then(|v| v.as_str()).unwrap_or("");
    check(
        merged.contains("dev.example.com") && merged.contains("test.example.com"),
        "preview 合并了两个方案",
    );
    check(std::fs::read_to_string(&tmp_hosts).unwrap() == before, "preview 未写 hosts");

    // 6) 双方案应用
    page(&mut input, 9, "apply", json!({ "ids": [id1, id2] }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(r.pointer("/result/ok").and_then(|v| v.as_bool()) == Some(true), "应用(方案1+2)成功");
    let hosts_now = std::fs::read_to_string(&tmp_hosts).unwrap();
    check(
        hosts_now.contains("dev.example.com") && hosts_now.contains("test.example.com"),
        "合并写入两方案",
    );
    check(std::fs::metadata(tmp_hosts.join("../hosts.spark-backup")).is_ok() || std::fs::metadata(dir.join("hosts.spark-backup")).is_ok(),
        "写入前已生成备份文件");

    // 7) 外部改动检测:改临时 hosts 后 get_state 应报 external_changed
    std::fs::write(&tmp_hosts, "# external edit\n").unwrap();
    page(&mut input, 10, "get_state", json!({}));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        r.pointer("/result/external_changed").and_then(|v| v.as_bool()) == Some(true),
        "hosts 被外部改动后 external_changed=true",
    );

    // 8) 改方案内容 + 仅公共配置应用(恢复纯 base)
    page(&mut input, 11, "update_scheme", json!({ "id": id1, "name": "开发环境2", "content": "10.0.0.11 dev2.example.com\n" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        r.pointer("/result/name").and_then(|v| v.as_str()) == Some("开发环境2"),
        "更新方案名与内容",
    );
    page(&mut input, 12, "apply", json!({ "ids": [] }));
    let _ = read_frame(&mut output);
    let hosts_now = std::fs::read_to_string(&tmp_hosts).unwrap();
    check(
        hosts_now.contains("# smoke seed") && !hosts_now.contains("Hosts切换 方案"),
        "空勾选应用 = 仅公共配置",
    );

    // 9) 删除方案2 + set_base
    page(&mut input, 13, "delete_scheme", json!({ "id": id2 }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(r.pointer("/result/ok").and_then(|v| v.as_bool()) == Some(true), "删除方案2");
    page(&mut input, 14, "delete_scheme", json!({ "id": "s-not-exist" }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(r.get("error").is_some(), "删除不存在的方案报错");

    page(&mut input, 15, "set_base", json!({ "content": "# new base\n" }));
    let _ = read_frame(&mut output);
    page(&mut input, 16, "get_state", json!({}));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        r.pointer("/result/base").and_then(|v| v.as_str()) == Some("# new base\n"),
        "修改公共配置",
    );

    // 10) export_base:备份公共配置到临时目录(不碰真实桌面)
    let backup_dir = dir.join("backup-out");
    page(&mut input, 17, "export_base", json!({ "dir": backup_dir.to_string_lossy() }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(r.pointer("/result/ok").and_then(|v| v.as_bool()) == Some(true), "export_base 备份公共配置");
    let mut backup_file = None;
    if let Ok(rd) = std::fs::read_dir(&backup_dir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("hosts-公共配置-") && name.ends_with(".txt") {
                backup_file = Some(entry.path());
                break;
            }
        }
    }
    check(
        backup_file
            .as_ref()
            .map(|p| std::fs::read_to_string(p).map(|c| c == "# new base\n").unwrap_or(false))
            .unwrap_or(false),
        "备份文件内容 = 公共配置原文",
    );

    // 11) 备份条目入列表:get_state 返回 backups,内容与文件一致
    page(&mut input, 18, "get_state", json!({}));
    let r = result_of(&read_frame(&mut output).unwrap());
    let bks = r.pointer("/result/backups").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    check(bks.len() == 1, "备份条目出现在 get_state");
    check(
        bks.first().and_then(|b| b.get("content")).and_then(|v| v.as_str()) == Some("# new base\n")
            && bks.first().and_then(|b| b.get("file")).and_then(|v| v.as_str()).map(|f| f.contains("hosts-公共配置-") && f.ends_with(".txt")).unwrap_or(false),
        "备份条目含内容与文件路径",
    );

    // 12) delete_backup:条目与文件一起消失
    let bk_id = bks.first().and_then(|b| b.get("id")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    page(&mut input, 19, "delete_backup", json!({ "id": bk_id }));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(r.pointer("/result/ok").and_then(|v| v.as_bool()) == Some(true), "delete_backup 删除条目");
    check(
        !backup_file.as_ref().map(|p| p.exists()).unwrap_or(false),
        "删除备份后文件一并移除",
    );
    page(&mut input, 20, "get_state", json!({}));
    let r = result_of(&read_frame(&mut output).unwrap());
    check(
        r.pointer("/result/backups").and_then(|v| v.as_array()).map(|a| a.is_empty()).unwrap_or(false),
        "删除后备份列表为空",
    );

    // 10) shutdown 通知(无 id)→ 进程应退出
    send(&mut input, &json!({ "jsonrpc": "2.0", "method": "plugin.shutdown", "params": null }));
    drop(input);
    match child.wait() {
        Ok(status) => println!("  PASS  shutdown 退出: {status}"),
        Err(e) => {
            println!("  FAIL  shutdown wait 失败: {e}");
            unsafe { FAILS += 1 };
        }
    }

    // 自清:进程已退出,夹具目录整体移除
    let _ = std::fs::remove_dir_all(&dir);

    let fails = unsafe { FAILS };
    println!("─────\n冒烟结束:{}", if fails == 0 { "全部通过".to_string() } else { format!("{fails} 项失败") });
    if fails > 0 {
        std::process::exit(1);
    }
}