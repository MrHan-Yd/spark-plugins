#!/usr/bin/env node
// 代理模式契约测试：外层假 client ──stdio──▶ host.mjs --proxy ──stdio──▶ mock agent。
//
// 断言七件事：
//   1) 外层 stdout 上只有 JSON 行（人话日志全部走 stderr，协议通道零污染）；
//   2) initialize / session/new / session/prompt 的响应逐条原样转发回外层；
//   3) agent 的 session/update 通知流转发回外层（思考/消息/工具调用可见）；
//   4) 反向请求（fs/write_text_file 等）被宿主就地处理：写盘真实发生、不外泄给外层；
//   5) session/new 被 _meta.sparkTrace 注入（mock 把 scratch 写进注入的 sandbox 即为证）；
//   6) events.jsonl 双向记录齐备：client->agent / agent->client / fs/write_applied / approval/* / 协议拒绝；
//   7) 外层 stdin 关闭后宿主优雅收尾：summary.json 与 index.json 落盘。
//
// 运行：node .agents/runner/tests/proxy-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(here, '..'); // 本测试在 .agents/runner/tests/ 下，runner 目录只隔一层
const HOST = path.join(RUNNER, 'host.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-test-'));
fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# 测试规则\n\n最小可读规则文件，供 mock agent 读取。\n');

const child = spawn(process.execPath, [HOST, '--proxy', '--mock', '--cwd', tmp, '--ws-port', '-1'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}`);
  }
};

const outLines = [];
const nonJson = [];
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    outLines.push(line);
    try {
      JSON.parse(line);
    } catch {
      nonJson.push(line);
    }
  }
});

let stderrAll = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (b) => {
  stderrAll += b;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

let nextId = 1;
async function request(method, params, timeoutMs = 20_000) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of outLines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === id && (msg.result !== undefined || msg.error !== undefined)) return msg;
    }
    await sleep(40);
  }
  throw new Error(`外层 client 等待 ${method} 响应超时`);
}

console.log('\n宿主代理模式 · 契约测试\n');
try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: {} },
    clientInfo: { name: 'proxy-test fake client', version: '0.0.0' },
  });
  ok(init.result?.protocolVersion === 1, 'initialize 响应转发回外层');

  const newSession = await request('session/new', { cwd: tmp, mcpServers: [] });
  ok(typeof newSession.result?.sessionId === 'string' && newSession.result.sessionId.startsWith('mock_'), 'session/new 响应转发回外层');

  const promptId = nextId++;
  send({ jsonrpc: '2.0', id: promptId, method: 'session/prompt', params: { sessionId: newSession.result.sessionId, content: [{ type: 'text', text: '按规则做一轮' }] } });
  const deadline = Date.now() + 30_000;
  let promptResp = null;
  let sawUpdate = false;
  while (Date.now() < deadline) {
    for (const line of outLines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method === 'session/update' && msg.params?.update?.kind === 'agent_thought_chunk') sawUpdate = true;
      if (msg.id === promptId && (msg.result !== undefined || msg.error !== undefined)) promptResp = msg;
    }
    if (promptResp) break;
    await sleep(40);
  }
  ok(sawUpdate, 'agent 的 session/update 通知流转发回外层');
  ok(promptResp?.result?.stopReason === 'end_turn', 'session/prompt 响应转发回外层（stopReason=end_turn）');

  const traceRoot = path.join(tmp, '.agents', 'trace');
  const sessions = fs.readdirSync(traceRoot).filter((n) => n.startsWith('s_'));
  ok(sessions.length === 1, '代理会话在 cwd 下的 .agents/trace 落盘');
  const eventsFile = path.join(traceRoot, sessions[0], 'events.jsonl');
  const events = fs
    .readFileSync(eventsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const dirCounts = { 'client->agent': 0, 'agent->client': 0, internal: 0 };
  for (const e of events) if (e.dir in dirCounts) dirCounts[e.dir] += 1;
  ok(dirCounts['client->agent'] >= 3, `client->agent 有记录（${dirCounts['client->agent']} 条）`);
  ok(dirCounts['agent->client'] >= 5, `agent->client 有记录（${dirCounts['agent->client']} 条）`);

  const hasMark = (name) => events.some((e) => e.kind === 'mark' && e.method === name);
  ok(hasMark('proxy/start'), 'proxy/start 落盘');
  ok(hasMark('proxy/session_new_mutated'), 'session/new 注入 _meta.sparkTrace 有记录');
  ok(hasMark('fs/write_applied'), '反向 fs/write_text_file 被宿主就地处理并落 fs/write_applied');
  ok(hasMark('approval/request') && hasMark('approval/decision'), '审批闸门请求/决策成对落盘');
  ok(hasMark('protocol/rejected_unknown_method'), 'mock 的错方法名（tools/call 等）被就地拒绝');
  ok(
    events.some((e) => e.kind === 'mark' && e.method === 'fs/write_applied' && String(e.payload?.path ?? '').includes('sandbox')),
    'mock 的 scratch 写进了注入的 sandbox（_meta 注入生效）',
  );

  child.stdin.end();
  const closed = await Promise.race([new Promise((r) => child.on('close', r)), sleep(15_000).then(() => 'timeout')]);
  ok(closed !== 'timeout', '外层 stdin 关闭后宿主进程退出');
  ok(nonJson.length === 0, `外层 stdout 零非 JSON 行（实测 ${nonJson.length} 条污染）`);
  ok(fs.existsSync(path.join(traceRoot, sessions[0], 'summary.json')), 'summary.json 已写');
  ok(fs.existsSync(path.join(traceRoot, 'index.json')), 'index.json 已重建');
} catch (e) {
  fail += 1;
  console.log(`  ✗ 测试执行中断：${e.message}`);
  console.log(`  [host stderr 尾部]\n${stderrAll.split('\n').slice(-15).join('\n')}`);
  try {
    child.kill();
  } catch {
    /* 忽略 */
  }
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

console.log(`\n────────────────\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);