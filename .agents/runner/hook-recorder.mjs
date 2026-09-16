#!/usr/bin/env node
// ZCode hook 桥录制器：把客户端 hook（PreToolUse 等）的工具调用追加进 .agents/trace，
// 让不经宿主的直开会话也有操作级留痕。事件标 provenance:'hook'——这是**客户端自报**，非协议观测，
// 没有审批闸门与合规链，深度到「哪个工具、哪个文件、什么命令」，不到 diff（见代理模式决策笔记备选方案 2）。
// 设计红线：永远 exit 0、stdout 静默——hook 报错或输出都会打断 agent 会话；字段解析失败有
// hook-raw.jsonl 全量原始 payload 兜底，事后可对账。
// @see [SPEC §Phase 0 代理模式](SPEC.md#phase-0--代理模式--proxy直开会话上链路)
// @see [宿主代理模式](../notes/implemented/architecture/2026-09-16-宿主代理模式.md)
//
// 用法（ZCode 钩子 UI，作用域=用户）：事件 PreToolUse；匹配器 Write, Edit, Bash；
// 命令 node；参数两行——本文件绝对路径、项目根。项目根是白名单：payload.cwd 不在根内就静默退出。
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex } from './trace-index.mjs';

const ROOT = path.resolve(process.argv[2] ?? process.cwd());
const LIMIT = { content: 4000, default: 800 };

const slim = (v, n) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…（截断，原文 ${v.length} 字符）` : v);

function fail(err) {
  // 失败只允许落在 sidecar 日志里，绝不向 agent 会话回话
  try {
    const dir = path.join(ROOT, '.agents', 'trace');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-error.log'), `${new Date().toISOString()} ${err?.stack ?? err}\n`);
  } catch {
    /* 连 sidecar 都写不进就只能吞掉 */
  }
  process.exit(0);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const chunks = [];
let handled = false;
let debounce = null;

function tryHandle() {
  if (handled) return;
  handled = true;
  try {
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    // 调试留痕：每次被拉起都记一笔（含空 stdin/白名单退出），用于区分「钩子没触发」和「触发但 payload 不对」
    try {
      const tdir = path.join(ROOT, '.agents', 'trace');
      fs.mkdirSync(tdir, { recursive: true });
      fs.appendFileSync(path.join(tdir, 'hook-debug.log'), `${new Date().toISOString()} argv=${JSON.stringify(process.argv.slice(2))} rawLen=${raw.length} procCwd=${process.cwd()} raw=${raw.slice(0, 300).replace(/\s+/g, ' ')}\n`);
    } catch {
      /* 调试日志失败不影响主流程 */
    }
    if (!raw) process.exit(0);
    const payload = JSON.parse(raw);
    const cwd = String(payload.cwd ?? process.cwd());
    const rel = path.relative(ROOT, cwd);
    // 白名单闸门：cwd 不在项目根内不落盘（hook 是用户级的，不能往别的项目写 trace）
    if (rel.startsWith('..') || path.isAbsolute(rel)) process.exit(0);

    const shortId = String(payload.session_id ?? payload.sessionId ?? new Date().toISOString().slice(0, 10).replace(/-/g, '')).replace(/[^\w-]/g, '_');
    const dirName = shortId.startsWith('hook_') ? shortId : `hook_${shortId}`;
    const dir = path.join(ROOT, '.agents', 'trace', dirName);
    fs.mkdirSync(dir, { recursive: true });
    // 原始 payload 全量留档：字段名猜错时从这里对账，也是 hook 自报的原始证据
    fs.appendFileSync(path.join(dir, 'hook-raw.jsonl'), `${raw}\n`);

    const file = path.join(dir, 'events.jsonl');
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    let seq = lines.length ? Number(JSON.parse(lines[lines.length - 1]).seq ?? 0) : 0;
    const base = { session_id: dirName, ts: Date.now(), dir: 'internal', kind: 'mark', parent_seq: null, turn_seq: null, provenance: 'hook' };
    const append = (ev) => {
      seq += 1;
      fs.appendFileSync(file, `${JSON.stringify({ ...base, ...ev, seq })}\n`);
    };
    if (!lines.length) {
      append({ method: 'hook/session_start', payload: { client_session: payload.session_id ?? payload.sessionId ?? null, cwd, root: ROOT } });
    }

    const eventName = String(payload.hook_event_name ?? payload.event ?? 'PreToolUse');
    const tool = payload.tool_name ?? payload.toolName ?? payload.tool ?? null;
    const input = payload.tool_input ?? payload.toolInput ?? payload.input ?? payload.params ?? null;
    let detail = null;
    if (input && typeof input === 'object') {
      detail = {};
      for (const [k, v] of Object.entries(input)) detail[k] = typeof v === 'string' ? slim(v, k === 'content' ? LIMIT.content : LIMIT.default) : v;
    } else if (typeof input === 'string') {
      detail = slim(input, LIMIT.default);
    }
    append({
      method: `hook/${eventName}`,
      payload: {
        tool,
        path: input && typeof input === 'object' ? (input.file_path ?? input.path ?? input.notebook_path ?? null) : null,
        command: input && typeof input === 'object' && typeof input.command === 'string' ? slim(input.command, 400) : null,
        input: detail,
      },
    });

    // 每次都重建索引：hook 会话没有宿主收尾流程，不重建看板就看不见它
    try {
      buildIndex({ cwd: ROOT });
    } catch {
      /* 索引失败不影响录制 */
    }
    process.exit(0);
  } catch (e) {
    fail(e);
  }
}

process.stdin.on('data', (c) => {
  chunks.push(c);
  if (debounce) clearTimeout(debounce);
  // 客户端可能不关闭 stdin：最后一段数据到达 120ms 后就解析，不等 EOF
  debounce = setTimeout(tryHandle, 120);
});
process.stdin.on('end', () => {
  if (debounce) clearTimeout(debounce);
  tryHandle();
});
// hook 进程兜底：5 秒内没拿到可解析输入也自行退出，绝不挂住会话
setTimeout(() => tryHandle(), 5000).unref();