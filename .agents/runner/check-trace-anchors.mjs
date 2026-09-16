#!/usr/bin/env node
/**
 * 代码 → 追溯记录的**反向锚点**校验器。
 *
 * 为什么要有它：锚点是"当初为什么这么写"的唯一入口，但它会腐烂 ——
 * 文件被改名、换目录、会话产物被清掉，链接就静默失效了。参考项目用 `check-note-anchors` 治这件事，
 * 这里对 ACP 追溯做同一件事，并且多支持一类更精确的坐标：**会话 + 事件序号**。
 *
 * 两种锚点：
 *
 *   @see [SPEC §4.3 审批流程与默认值](SPEC.md#43-审批流程与默认值)
 *        → 仓库内的文档锚点。路径相对当前文件；`#fragment` 会被忽略后校验文件是否存在。
 *
 *   @trace s_20260915-160302_1908bc#34 实测：看板点拒绝后，磁盘上确实没有那个文件
 *        → 追溯坐标 `<session_id>#<seq>`。若 `.agents/trace/<session>/events.jsonl` 在，
 *          就要求该 seq 真的存在（硬校验）；不在就记 SKIPPED —— 追溯产物不进仓库，
 *          不能要求别人的 clone 里有它。这一点必须分清，否则校验会变成噪音。
 *
 * 用法：
 *   node .agents/runner/check-trace-anchors.mjs                          # 扫默认根
 *   node .agents/runner/check-trace-anchors.mjs trace-board .agents/runner
 *   node .agents/runner/check-trace-anchors.mjs --json                   # 机器可读
 *
 * 需要在自己注释里写示例格式的文件（比如本文件），加一行 `@anchors-skip` 让校验器跳过整个文件，
 * 否则"示例"会被当成真锚点 —— 实测踩过：本文件的两个示例被算成了两个通过项。
 *
 * @anchors-skip 本文件是校验器自身，注释里的 @see / @trace 是格式示例，不是真锚点
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOTS = ['.agents/runner', 'trace-board', '.agents/skills']; // 技能脚本同受锚点契约约束
const SCAN_EXT = /\.(m|c)?js$/i;
const MAX_FILES = 400;
const SKIP_MARK = /@anchors-skip\b/;

/* ── 解析 ───────────────────────────────────────────────────────────────── */

/** 从源码文本里抽出锚点。只认注释行，避免把字符串里的示例当成真锚点。 */
export function extractAnchors(text) {
  const out = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*(\/\/|\/\*|\*)/.test(line)) continue;          // 只在注释里找

    const see = line.match(/@see\s+\[([^\]]*)\]\(([^)\s]+)\)/);
    if (see) {
      const raw = see[2];
      out.push({ kind: 'see', line: i + 1, text: see[1], target: raw.split('#')[0], fragment: raw.split('#')[1] || null, raw });
    } else {
      const seePlain = line.match(/@see\s+((?:\.\.?\/|\/)[^\s*]+\.(?:md|json|jsonl))/);
      if (seePlain) out.push({ kind: 'see', line: i + 1, text: '', target: seePlain[1].split('#')[0], fragment: null, raw: seePlain[1] });
    }

    const tr = line.match(/@trace\s+(s_[A-Za-z0-9_-]+)(?:#(\d+))?/);
    if (tr) {
      out.push({ kind: 'trace', line: i + 1, session: tr[1], seq: tr[2] ? Number(tr[2]) : null, raw: tr[0] });
    }
  }
  return out;
}

/* ── 校验 ───────────────────────────────────────────────────────────────── */

function readEvents(traceRoot, session) {
  const file = path.join(traceRoot, session, 'events.jsonl');
  if (!fs.existsSync(file)) return null;
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行忽略 */ }
  }
  return out;
}

/**
 * @param {{absPath:string, cwd:string}} args
 * @returns {{anchors:Array, ok:Array, failures:Array, skipped:Array}}
 */
export function checkFile({ absPath, cwd }) {
  const traceRoot = path.join(cwd, '.agents', 'trace');
  const dir = path.dirname(absPath);
  const text = fs.readFileSync(absPath, 'utf8');
  if (SKIP_MARK.test(text)) return { anchors: [], ok: [], failures: [], skipped: [], optedOut: true };
  const anchors = extractAnchors(text);
  const ok = [];
  const failures = [];
  const skipped = [];

  for (const a of anchors) {
    if (a.kind === 'see') {
      const target = path.resolve(dir, a.target);
      if (fs.existsSync(target)) ok.push(a);
      else failures.push(Object.assign({}, a, { reason: `指向的文件不存在：${a.target}` }));
      continue;
    }
    const events = readEvents(traceRoot, a.session);
    if (events === null) {
      skipped.push(Object.assign({}, a, { reason: '会话产物不在本机（.agents/trace 不进仓库）' }));
      continue;
    }
    if (a.seq == null) { ok.push(a); continue; }
    if (events.some((e) => e.seq === a.seq)) ok.push(a);
    else failures.push(Object.assign({}, a, { reason: `会话 ${a.session} 里没有 seq ${a.seq}（该会话共 ${events.length} 条）` }));
  }
  return { anchors, ok, failures, skipped, optedOut: false };
}

/* ── 扫目录 ─────────────────────────────────────────────────────────────── */

function walk(root, acc) {
  if (acc.length >= MAX_FILES || !fs.existsSync(root)) return acc;
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (acc.length >= MAX_FILES) break;
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const p = path.join(root, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (SCAN_EXT.test(ent.name)) acc.push(p);
  }
  return acc;
}

export function scan({ cwd, roots = DEFAULT_ROOTS }) {
  const files = [];
  for (const r of roots) walk(path.resolve(cwd, r), files);
  const results = files.map((f) => Object.assign({ file: path.relative(cwd, f).split(path.sep).join('/') }, checkFile({ absPath: f, cwd })));
  return {
    files: results.length,
    results,
    anchors: results.reduce((n, r) => n + r.anchors.length, 0),
    failures: results.flatMap((r) => r.failures.map((f) => Object.assign({ file: r.file }, f))),
    skipped: results.flatMap((r) => r.skipped.map((f) => Object.assign({ file: r.file }, f))),
    truncated: files.length >= MAX_FILES,
  };
}

/* ── CLI ────────────────────────────────────────────────────────────────── */
function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const roots = argv.filter((a) => !a.startsWith('--'));
  const cwd = process.cwd();
  const res = scan({ cwd, roots: roots.length ? roots : DEFAULT_ROOTS });

  if (json) {
    process.stdout.write(`${JSON.stringify(res, null, 1)}\n`);
  } else {
    process.stdout.write(`\n代码 → 追溯 反向锚点校验\n`);
    process.stdout.write(`扫描 ${res.files} 个文件，找到 ${res.anchors} 个锚点\n\n`);
    for (const r of res.results) {
      if (!r.anchors.length) continue;
      const bad = r.failures.length;
      process.stdout.write(`  ${bad ? '✗' : '✓'} ${r.file}  (${r.anchors.length} 个)\n`);
      for (const a of r.anchors) {
        if (r.failures.includes(a)) continue;
        if (r.skipped.includes(a)) {
          process.stdout.write(`      · ${a.raw}  —— 会话不在本机，跳过\n`);
          continue;
        }
        const label = a.kind === 'see' ? `文档 ${a.target}` : `${a.session}${a.seq != null ? '#' + a.seq : ''}`;
        process.stdout.write(`      ✓ ${label}  (第 ${a.line} 行)\n`);
      }
      for (const f of r.failures) process.stdout.write(`      ✗ 第 ${f.line} 行 ${f.raw}  → ${f.reason}\n`);
    }
    if (!res.anchors) process.stdout.write('  （没有找到任何锚点）\n');
    const optedOut = res.results.filter((r) => r.optedOut).length;
    process.stdout.write(`\n通过 ${res.anchors - res.failures.length - res.skipped.length} 个 · 跳过 ${res.skipped.length} 个 · **失效 ${res.failures.length} 个**`);
    if (optedOut) process.stdout.write(` · 声明 @anchors-skip 而整体跳过的文件 ${optedOut} 个`);
    process.stdout.write('\n');
    if (res.truncated) process.stdout.write(`注意：文件数达到上限 ${MAX_FILES}，只扫了一部分\n`);
    if (res.skipped.length) process.stdout.write('跳过的都是"会话产物不在本机"，不算失效 —— 追溯数据本身不进仓库。\n');
    process.stdout.write('\n');
  }
  process.exit(res.failures.length ? 1 : 0);
}
