//! 冒烟测试:手动以 host 的方式驱动插件协议帧(纯应用模型:`plugin.page` RPC)。
//! 运行:`cargo run --example smoke`(仅开发用,不进发布物)。

use serde_json::json;
use std::io::{BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

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

fn main() {
    let exe = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/0.1.0/spark-plugin-local-search.exe"
    );
    let mut child = Command::new(exe)
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
            "params": { "id": "com.spark.local-search", "permissions": [], "api_version": 1 }
        }),
    );
    println!("[init] {}", String::from_utf8_lossy(&read_frame(&mut output).unwrap()));

    // 2) 空查询:拿索引进度形状
    page(&mut input, 2, "search", json!({ "text": "" }));
    println!("[空查询] {}", String::from_utf8_lossy(&read_frame(&mut output).unwrap()));

    // 3) get_config → 页面设置面板的数据形状
    page(&mut input, 3, "get_config", json!({}));
    println!("[配置] {}", String::from_utf8_lossy(&read_frame(&mut output).unwrap()));

    // 4) 轮询真实搜索,直到索引建完拿到命中(或超时只拿到进度)
    let deadline = Instant::now() + Duration::from_secs(240);
    let search_text = std::env::args().nth(1).unwrap_or_else(|| "local-search".into());
    let mut seq = 3u64;
    let last = loop {
        seq += 1;
        page(&mut input, seq, "search", json!({ "text": search_text, "limit": 10 }));
        let frame = read_frame(&mut output).unwrap();
        let text = String::from_utf8_lossy(&frame).to_string();
        println!("[search] {text}");
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(json!({}));
        let done_all = v.pointer("/result/progress/done") == v.pointer("/result/progress/total")
            && v.pointer("/result/progress/total").and_then(|t| t.as_u64()) != Some(0);
        let has_hits = v
            .pointer("/result/hits")
            .and_then(|h| h.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        if (done_all && has_hits) || Instant::now() > deadline {
            break v;
        }
        std::thread::sleep(Duration::from_secs(5));
    };

    // 5) 拿第一个真实命中调 copy_path(经 rpc,PowerShell 写剪贴板)
    let first_hit = last
        .pointer("/result/hits")
        .and_then(|h| h.as_array())
        .and_then(|arr| arr.first())
        .cloned();
    if let Some(hit) = first_hit {
        let path = hit["path"].as_str().unwrap().to_string();
        page(&mut input, 99, "copy_path", json!({ "path": path }));
        println!("[copy_path] {}", String::from_utf8_lossy(&read_frame(&mut output).unwrap()));
    } else {
        println!("[copy_path] 跳过:没有真实命中项");
    }

    // 6) shutdown 通知(无 id)→ 进程应退出
    send(&mut input, &json!({ "jsonrpc": "2.0", "method": "plugin.shutdown", "params": null }));
    drop(input);
    match child.wait() {
        Ok(status) => println!("[shutdown] 进程已退出: {status}"),
        Err(e) => println!("[shutdown] wait 失败: {e}"),
    }
}