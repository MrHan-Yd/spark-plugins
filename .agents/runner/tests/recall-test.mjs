#!/usr/bin/env node
// recall.mjs 契约测试：在临时目录里合成最小 trace（events.jsonl + notes），断言三类查询的口径。
// 与 proxy-test 合成真会话不同，这里直接铺 events.jsonl —— recall 是纯读盘层，没必要拉起宿主。
//
// 运行：node .agents/runner/tests/recall-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RECALL = path.resolve(here, '..', 'recall.mjs');

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}`); }
};

/* ── 合成样本：两个会话 + 两篇笔记 ─────────────────────────────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-test-'));
const traceDir = path.join(tmp, '.agents', 'trace', 's_20260916-120000_aaa111');
fs.mkdirSync(traceDir, { recursive: true });

const events = [
  { seq: 1, ts: 1000, session_id: 's_20260916-120000_aaa111', dir: 'client->agent', method: 'session/prompt', acp_message: { params: { prompt: '改 app.js' } } },
  // 写盘被拒（审批）：parent 指向那次 fs/write_text_file
  { seq: 2, ts: 2000, session_id: 's_20260916-120000_aaa111', dir: 'agent->client', method: 'fs/write_text_file', acp_message: { params: { path: 'src/app.js' } } },
  { seq: 3, ts: 3000, parent_seq: 2, session_id: 's_20260916-120000_aaa111', dir: 'agent->client', method: 'approval/decision', payload: { method: 'fs/write_text_file', approved: false, decided_by: 'user' } },
  // 写盘落盘
  { seq: 4, ts: 4000, session_id: 's_20260916-120000_aaa111', dir: 'agent->client', method: 'fs/write_applied', payload: { path: 'src/lib.js', created: false, before_lines: 10, after_lines: 20 } },
  // 合规未过
  { seq: 5, ts: 5000, parent_seq: 4, session_id: 's_20260916-120000_aaa111', dir: 'internal', compliance_check: { rule_id: 'AGENTS_MD_SEC_2_SYNTAX', rule_source: 'AGENTS.md §2', status: 'FAILED', message: '语法错误', details: {} } },
];
fs.writeFileSync(path.join(traceDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

const noteDir = path.join(tmp, '.agents', 'notes', 'implemented', 'architecture');
fs.mkdirSync(noteDir, { recursive: true });
fs.writeFileSync(path.join(noteDir, '2026-09-16-库文件决策.md'), [
  '# Agent Note: 库文件决策', 'Status: implemented', 'Class: architecture', '',
  '## 背景', '动 src/app.js 之前先回查。', '## 决策', '采用方案 A。', '## 放弃方案', '无。', '## 代价与后果', '无。',
].join('\n'));

function run(args, cwd = tmp) {
  const r = spawnSync(process.execPath, [RECALL, ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`recall ${args.join(' ')} exit ${r.status}：${r.stderr}`);
  return r.stdout;
}

/* ── 断言 ─────────────────────────────────────────────────────── */
console.log('recall 契约');

let out = run(['--path', 'src/app.js', '--json']);
let data = JSON.parse(out);
ok(data.hits.length === 1, '--path 命中审批被拒一条（落盘的是别的文件，不串）');
ok(data.hits[0].kind === '审批被拒' && data.hits[0].seq === 3, '被拒记录解出 parent 的目标路径');
ok(data.notes.length === 1 && data.notes[0].id === '2026-09-16-库文件决策', '正文提到路径的笔记一并给出');

out = run(['--path', 'src/lib.js', '--json']);
data = JSON.parse(out);
ok(data.hits.some((h) => h.kind === '写盘'), '路径查询命中落盘记录');

out = run(['--rule', 'AGENTS_MD_SEC_2_SYNTAX', '--json']);
data = JSON.parse(out);
ok(data.rule.total === 1 && data.rule.failed === 1, '--rule 台账计数正确');
ok(data.failed.length === 1 && data.failed[0].target === 'src/lib.js', '未通过条目从 parent 解出对象路径');

out = run(['--denied', '--json']);
data = JSON.parse(out);
ok(data.denied.some((d) => d.kind === '审批被拒' && d.target === 'src/app.js'), '--denied 聚合出被拒目标');
ok(data.denied[0].sessions.length === 1, '按目标聚合带会话计数');

out = run(['--notes', '--json']);
data = JSON.parse(out);
ok(data.notes.length === 1, '--notes 列出全库笔记');

// 空库：没有 .agents/trace 的目录照样 exit 0、结构完整
out = run(['--denied', '--json'], fs.mkdtempSync(path.join(os.tmpdir(), 'recall-empty-')));
data = JSON.parse(out);
ok(data.denied.length === 0, '空库 exit 0 空结果');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);