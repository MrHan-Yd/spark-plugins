/* 追溯看板 · runner↔看板 枚举契约测试
 *
 * 运行：node trace-board/tests/contract-test.mjs
 *
 * 防的事：runner 扩合规状态枚举（SPEC §6.2）时，看板忘了同步 analyze.js 的 COMPLIANCE_STATUS 表。
 * v2 加 WARN 那次是手工同步 analyze/render 两个文件里的三个点，没有任何机制兜底；
 * 现在把三个来源拉到一起机械比对：SPEC 文档、看板唯一权威表、runner 源码里实际产出的字面量。
 *
 * @see [SPEC §5.8 看板入口索引与 digest schema](../../.agents/runner/SPEC.md#58-看板入口索引与-digest-schema)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('\n追溯看板 · 枚举契约测试\n');

/* ── 1) 看板权威表：analyze.js 是 IIFE + globalThis 直挂、无 DOM 依赖，vm 里直接跑 ── */
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'trace-board', '0.1.0', 'analyze.js'), 'utf8'),
  sandbox,
  { filename: 'trace-board/0.1.0/analyze.js' },
);
const board = sandbox.TraceAnalyze;
ok('analyze.js 在 vm 里载入并导出 COMPLIANCE_STATUS', !!board && !!board.COMPLIANCE_STATUS);

const TABLE = board.COMPLIANCE_STATUS || {};
const boardKeys = new Set(Object.keys(TABLE));

/* ── 2) SPEC §6.2 文档里的状态集合 ──────────────────────────────── */
const spec = fs.readFileSync(path.join(ROOT, '.agents', 'runner', 'SPEC.md'), 'utf8');
const sec62 = spec.split('### 6.2')[1] || '';
const sec62Body = sec62.split('### 6.3')[0];
const specStatuses = new Set([...sec62Body.matchAll(/^\|\s*`([A-Z_]+)`/gm)].map((m) => m[1]));
ok('SPEC §6.2 状态表解析出 ≥2 个状态', specStatuses.size >= 2, [...specStatuses].join(', ') || '(空)');

/* ── 3) runner 源码里实际产出的合规状态字面量（status: 'X'）──────────
 * 只扫**生产方**：compliance.mjs（pass/fail/warn/skip 五态的生产者）与 host.mjs
 * （检查器自身抛异常时包一层 status:'ERROR' 的记录）。
 * trace.mjs 的 validate() 也产 status:'OK'/'ERROR'，但那是协议校验域（protocol.status），
 * 与合规枚举（§6.2）是两个同名字段、两套枚举，混进来就是误报。 */
const runnerFiles = ['compliance.mjs', 'host.mjs'];
const runnerStatuses = new Set();
for (const f of runnerFiles) {
  const p = path.join(ROOT, '.agents', 'runner', f);
  if (!fs.existsSync(p)) continue;
  for (const m of fs.readFileSync(p, 'utf8').matchAll(/\bstatus\s*(?::|===?|==)\s*['"]([A-Z_]+)['"]/g)) {
    runnerStatuses.add(m[1]);
  }
}
console.log('  runner 侧扫到的状态字面量：' + [...runnerStatuses].sort().join(', ') + '\n');

/* ── 4) 三方对齐 ───────────────────────────────────────────────── */
ok('SPEC §6.2 与看板表完全一致',
  specStatuses.size === boardKeys.size && [...specStatuses].every((s) => boardKeys.has(s)),
  'SPEC: [' + [...specStatuses].join(', ') + '] / 看板: [' + [...boardKeys].join(', ') + ']');

const missingInBoard = [...runnerStatuses].filter((s) => !boardKeys.has(s));
ok('runner 产出的每个状态看板表里都有（扩枚举漏同步即红）', missingInBoard.length === 0,
  missingInBoard.join(', ') || '全齐');

for (const s of [...runnerStatuses].sort()) {
  ok('  · ' + s + ' 的 label/cls/rank 齐备且 cls 合法',
    TABLE[s] && typeof TABLE[s].label === 'string' && TABLE[s].label.length > 0 &&
    /^chip-(ok|bad|warn|skip|dir)$/.test(TABLE[s].cls || '') && typeof TABLE[s].rank === 'number',
    TABLE[s] ? JSON.stringify(TABLE[s]) : '(缺)');
}

/* ── 5) 派生导出与兜底行为 ─────────────────────────────────────── */
ok('旧导出 STATUS_LABEL 与单表派生一致',
  !!board.STATUS_LABEL && Object.keys(board.STATUS_LABEL).length === boardKeys.size &&
  Object.keys(board.STATUS_LABEL).every((k) => board.STATUS_LABEL[k] === TABLE[k].label));
ok('旧导出 STATUS_CLASS 与单表派生一致',
  !!board.STATUS_CLASS && Object.keys(board.STATUS_CLASS).length === boardKeys.size &&
  Object.keys(board.STATUS_CLASS).every((k) => board.STATUS_CLASS[k] === TABLE[k].cls));
ok('statusRank 对未知状态兜底到末位且不抛错',
  board.statusRank('NOT_A_STATUS') > Math.max(...Object.keys(TABLE).map((k) => TABLE[k].rank)));
ok('statusHeadline 恒含 FAILED、零值的其他状态不显示',
  JSON.stringify(board.statusHeadline({ FAILED: 0, PASSED: 3 })) === JSON.stringify(['未通过 0', '通过 3']),
  JSON.stringify(board.statusHeadline({ FAILED: 0, PASSED: 3 })));

console.log('\n────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);