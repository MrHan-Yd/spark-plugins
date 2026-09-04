//! 帧编解码 + wire 消息类型(对齐 host `crates/ipc` 的 wire 协议 v1)。
//!
//! 每帧 = 4 字节小端 u32 长度(不含自身)+ UTF-8 JSON body,上限 16 MiB。
//! stdout 必须纯净协议帧,任何杂质都会破坏 host 的帧解析;日志一律走 stderr。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, Read, Write};

/// 单帧 body 最大字节数(与 host `MAX_FRAME_LEN` 一致)。
pub const MAX_FRAME_LEN: u32 = 16 * 1024 * 1024;

/// 写一帧:4 字节小端长度 + body,写完立即 flush(host 在等)。
pub fn write_frame<W: Write>(w: &mut W, body: &[u8]) -> io::Result<()> {
    let len = u32::try_from(body.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "frame body too large"))?;
    w.write_all(&len.to_le_bytes())?;
    w.write_all(body)?;
    w.flush()
}

/// 读一帧;对端在帧边界前关闭返回 `Ok(None)`(干净 EOF,上层据此退出)。
pub fn read_frame<R: Read>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    let mut filled = 0;
    while filled < header.len() {
        match r.read(&mut header[filled..]) {
            Ok(0) => {
                if filled == 0 {
                    return Ok(None);
                }
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "eof mid-frame header",
                ));
            }
            Ok(n) => filled += n,
            Err(e) => return Err(e),
        }
    }
    let len = u32::from_le_bytes(header);
    if len > MAX_FRAME_LEN {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut body = vec![0u8; len as usize];
    r.read_exact(&mut body)?;
    Ok(Some(body))
}

/// host → 插件请求(宽松解析:host 侧才是严格 `deny_unknown_fields` 的一方)。
#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// `plugin.page` 参数:页面 `spark.rpc(method, args)` 经 host 原样转发。
#[derive(Debug, Deserialize)]
pub struct PluginPageParams {
    pub method: String,
    #[serde(default)]
    pub args: Value,
}

pub fn ok_response(id: Value, result: Value) -> Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn err_response(id: Value, code: i64, message: &str) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

/// 序列化失败等内部错误的兜底:转成 JSON-RPC error。
pub fn value_or_err<T: Serialize>(id: Value, value: &T) -> Value {
    match serde_json::to_value(value) {
        Ok(v) => ok_response(id, v),
        Err(e) => err_response(id, -32603, &e.to_string()),
    }
}