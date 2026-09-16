#!/usr/bin/env node
// 归档通道的读取端：不连任何服务，只读 events.jsonl。
// 这一层就是将来那个「单文件 HTML 看板」要接的东西 —— 纯读盘、零后端、可离线、可回放。
// 用法：
//   node trace-report.mjs                        # 默认取 .agents/trace 下最新一次会话
//   node trace-report.mjs .agents/trace/s_xxx     # 指定会话目录
//   node trace-report.mjs --chain 18              # 从指定 seq 展开血缘
//   node trace-report.mjs --no-gate               # 不合规也不返回非零码
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const noGate = argv.includes('--no-gate');
const chainIdx = argv.indexOf('--chain');
const chainSeq = chainIdx >= 0 ? Number(argv[chainIdx + 1]) : null;
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--chain');

function resolveSession(arg) {
  if (arg) {
    const p = path.resolve(arg);
    if (fs.existsSync(path.join(p, 'events.jsonl'))) return p;
    throw new Error(`${arg} 下没有 events.jsonl`);
  }
  const root = path.resolve('.agents/trace');
  if (!fs.existsSync(root)) throw new Error('没找到 .agents/trace，先跑一次 host.mjs');
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'events.jsonl')))
    .map((d) => ({ name: d.name, mtime: fs.statSync(path.join(root, d.name, 'events.jsonl')).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!dirs.length) throw new Error('.agents/trace 下没有可读的会话');
  return path.join(root, dirs[0].name);
}

const dir = resolveSession(positional[0]);
const rel = (p) => path.relative(process.cwd(), p).split(path.sep).join('/');
// 事件里的 path 是相对项目根的全路径；本会话目录前缀对读的人没信息量，读的时候就抹掉
const shortPath = (p) => String(p).replace(/^\.agents\/trace\/[^/]+\//, '');
const events = fs
  .readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const summary = fs.existsSync(path.join(dir, 'summary.json'))
  ? JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'))
  : null;

const out = [];
const w = (s = '') => out.push(s);
const num = (n) => String(n).padStart(3, ' ');

w('');
w(`会话     ${path.basename(dir)}`);
w(`项目     ${events[0]?.project_path ?? '(unknown)'}`);
w(`事件     ${events.length} 条 · 跨度 ${(((events.at(-1)?.ts ?? 0) - (events[0]?.ts ?? 0)) / 1000).toFixed(1)}s`);
if (summary) {
  w(`规则     ${summary.rules_source ?? '(none)'} @ ${summary.rules_sha256_16 ?? '-'}`);
  w(`策略     ${summary.policy} · stopReason ${summary.stop_reason}`);
}
w(`目录     ${rel(dir)}`);

// ── 阶段时间线 ────────────────────────────────────────────────────────────
w('');
w('■ 生命周期');
for (const e of events) {
  if (e.dir !== 'client->agent' || e.kind !== 'request') continue;
  if (!['initialize', 'session/new', 'session/prompt'].includes(e.method)) continue;
  const detail =
    e.method === 'initialize'
      ? `protocolVersion=${e.acp_message?.params?.protocolVersion}`
      : e.method === 'session/new'
        ? `cwd=${e.acp_message?.params?.cwd} · _meta 带规则指纹 ${e.acp_message?.params?._meta?.sparkTrace?.rules_sha256_16 ?? '-'}`
        : `content=${(e.acp_message?.params?.content ?? []).map((c) => c.type).join('+')}`;
  w(`  ${num(e.seq)} ${e.method.padEnd(15)} ${detail}`);
}

// ── 协议错误 ──────────────────────────────────────────────────────────────
const protoErrors = events.filter((e) => e.protocol?.status === 'ERROR');
w('');
w(`■ 协议错误：${protoErrors.length} 条`);
for (const e of protoErrors) {
  const p = e.protocol;
  w(`  ${num(e.seq)} ${e.dir.padEnd(13)} ${String(e.method).padEnd(22)} ${p.error.code} ${p.error.message}`);
  if (p.error.hint) w(`        └ 原文档里的名字：${p.error.hint}`);
}

// ── 审批 ──────────────────────────────────────────────────────────────────
const approvals = events.filter((e) => e.method === 'approval/decision');
w('');
w(`■ 审批拦截：${approvals.length} 次`);
for (const e of approvals) {
  const p = e.payload;
  w(`  ${num(e.seq)} ${p.approved ? '放行' : '拒绝'} ${String(p.method).padEnd(24)} ${p.decided_by.padEnd(14)} ${p.latency_ms}ms`);
}

// ── 副作用：批准了什么，拒掉了什么 ────────────────────────────────────────
const applied = events.filter((e) => e.method === 'fs/write_applied');
const writeAttempts = events.filter((e) => e.method === 'fs/write_text_file');
const termAttempts = events.filter((e) => e.method === 'terminal/create');
const termExecuted = events.filter((e) => e.method === 'terminal/created');
const denied = (summary?.counts?.write_attempts ?? writeAttempts.length) - (summary?.counts?.write_applied ?? applied.length);
w('');
w(`■ 副作用：写盘 尝试 ${writeAttempts.length} · 落盘 ${applied.length} · 被拒 ${denied}；命令 尝试 ${termAttempts.length} · 执行 ${termExecuted.length}`);
for (const e of applied) {
  w(`  ${num(e.seq)} 落盘 ${shortPath(e.payload.path).padEnd(44)} ${e.payload.before_lines}→${e.payload.after_lines} 行`);
}
for (const e of termExecuted) {
  w(`  ${num(e.seq)} 执行 ${(e.payload.command ?? []).join(' ')}`);
}

// ── 合规 ──────────────────────────────────────────────────────────────────
const comp = events.filter((e) => e.compliance_check);
const failed = comp.filter((e) => e.compliance_check.status === 'FAILED');
w('');
w(`■ 合规检查：跑 ${comp.length} 条 · 通过 ${comp.filter((e) => e.compliance_check.status === 'PASSED').length} · 未通过 ${failed.length} · 跳过 ${comp.filter((e) => e.compliance_check.status === 'SKIPPED').length}`);
for (const e of failed) {
  w(`  ${num(e.seq)} ✗ ${e.compliance_check.rule_id}`);
  w(`        ${e.compliance_check.message}`);
  w(`        依据 ${e.compliance_check.rule_source}`);
}

// ── 血缘 ──────────────────────────────────────────────────────────────────
const roots = events.filter((e) => e.dir === 'client->agent' && e.method === 'session/prompt');
const rootSeq = chainSeq ?? roots[0]?.seq ?? null;
if (rootSeq !== null) {
  const byParent = new Map();
  for (const e of events) {
    if (e.parent_seq === null || e.parent_seq === undefined) continue;
    if (!byParent.has(e.parent_seq)) byParent.set(e.parent_seq, []);
    byParent.get(e.parent_seq).push(e);
  }
  w('');
  w(`■ 血缘（根 #${rootSeq}）`);
  const label = (e) => {
    const tag = e.compliance_check ? `[${e.compliance_check.status}] ` : '';
    const rpc = e.rpc_id !== null && e.rpc_id !== undefined ? ` (id=${e.rpc_id})` : '';
    return `${num(e.seq)} ${e.dir.padEnd(13)} ${tag}${e.method}${rpc}`;
  };
  const walk = (seq, prefix, depth) => {
    const kids = byParent.get(seq) ?? [];
    kids.forEach((k, i) => {
      const last = i === kids.length - 1;
      w(`  ${prefix}${last ? '└─ ' : '├─ '}${label(k)}`);
      if (depth < 3) walk(k.seq, `${prefix}${last ? '   ' : '│  '}`, depth + 1);
    });
  };
  const root = events.find((e) => e.seq === rootSeq);
  if (root) w(`  ${label(root)}`);
  walk(rootSeq, '', 0);
}

w('');
w(`事件流     ${rel(path.join(dir, 'events.jsonl'))}`);
w(`摘要       ${rel(path.join(dir, 'summary.json'))}`);
w(`快照/Diff  ${rel(path.join(dir, 'snapshots'))} · ${rel(path.join(dir, 'diffs'))}`);
w('');

process.stdout.write(out.join('\n'));

const shouldGate = !noGate && (failed.length > 0 || protoErrors.length > 0);
process.exit(shouldGate ? 1 : 0);
