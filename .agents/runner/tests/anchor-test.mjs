/**
 * 反向锚点校验器的失效路径测试。
 *
 * 运行：node .agents/runner/tests/anchor-test.mjs
 *
 * 为什么要单测失败路径：只测「通过」等于没测。锚点校验的价值全在「失效能被抓到」，
 * 以及「会话不在本机时不该误报」—— 追溯产物不进仓库，这条判错会让校验变成噪音，最后被人关掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFile } from '../check-trace-anchors.mjs';
import { checkTraceAnchors } from '../compliance.mjs';

const cwd = process.cwd();
const tmp = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cases');
fs.mkdirSync(tmp, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  XX  ' + name + (extra ? '  -> ' + extra : '')); }
};

const write = (name, lines) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, lines.join('\n'));
  return p;
};
const rel = (p) => path.relative(cwd, p).split(path.sep).join('/');

// 注意：fixture 放在 tests/.cases/ 下，所以指向 SPEC.md 的相对路径要退两层
const SPEC = '../../SPEC.md';
// 指向本机真实存在的会话（2026-09-16 真实回填会话）；在别的机器上该会话不在，
// @trace 会退化为 SKIPPED——与"追溯产物不进仓库"的契约一致（见用例 D）
const REAL_SESSION = 's_20260916-101829_e11f68';

// A) 全部有效
const good = write('good.js', [
  '/**',
  ` * @see [SPEC](${SPEC})`,
  ` * @trace ${REAL_SESSION}#23`,
  ' */',
  'export const a = 1;',
]);
const ra = checkFile({ absPath: good, cwd });
ok('有效锚点全部解析', ra.failures.length === 0 && ra.ok.length === 2, JSON.stringify(ra.failures));

// B) @see 指向不存在的文件（同一条注释里放一个有效的做对照，避免把"整块失效"当成本条失效）
const badSee = write('bad-see.js', [
  '/**',
  ` * @see [存在的](${SPEC})`,
  ' * @see [不存在的](nope-missing.md)',
  ' */',
  'export const b = 1;',
]);
const rb = checkFile({ absPath: badSee, cwd });
ok('@see 指向不存在的文件被判失效', rb.failures.length === 1 && /nope-missing\.md/.test(rb.failures[0].reason), JSON.stringify(rb.failures));

// C) @trace 的 seq 在该会话里不存在
const badSeq = write('bad-seq.js', ['/**', ` * @trace ${REAL_SESSION}#999999`, ' */', 'export const c = 1;']);
const rc = checkFile({ absPath: badSeq, cwd });
ok('@trace 的 seq 不存在被判失效', rc.failures.length === 1 && /没有 seq 999999/.test(rc.failures[0].reason), JSON.stringify(rc.failures));

// D) 会话不在本机 -> 跳过，不算失效
const ghost = write('ghost.js', ['/**', ' * @trace s_19700101-000000_zzzzzz#1', ' */', 'export const d = 1;']);
const rd = checkFile({ absPath: ghost, cwd });
ok('会话不在本机时跳过而非报错', rd.failures.length === 0 && rd.skipped.length === 1, JSON.stringify(rd));

// E) 声明 @anchors-skip 的文件整体跳过
const opted = write('opted-out.js', ['/**', ' * 示例：@see [x](nope.md)', ' * @anchors-skip 本文件只是文档', ' */', 'export const e = 1;']);
const re = checkFile({ absPath: opted, cwd });
ok('@anchors-skip 整体跳过', re.optedOut === true && re.anchors.length === 0, JSON.stringify(re));

// F) 非注释里的 @see / @trace 不算锚点（避免把字符串示例当真）
const inString = write('in-string.js', ['export const s = "@see [假的](nope.md) @trace s_1#1";', '// 上面那行不是注释，不该被当成锚点']);
const rf = checkFile({ absPath: inString, cwd });
ok('非注释行里的 @see/@trace 不算锚点', rf.anchors.length === 0, JSON.stringify(rf.anchors));

// G) 接进合规链：状态要落到 PASSED / FAILED / PASSED(带跳过) / SKIPPED
const cA = checkTraceAnchors(good, rel(good), cwd);
const cB = checkTraceAnchors(badSee, rel(badSee), cwd);
const cC = checkTraceAnchors(badSeq, rel(badSeq), cwd);
const cD = checkTraceAnchors(ghost, rel(ghost), cwd);
const cE = checkTraceAnchors(path.join(tmp, 'plain.html'), 'demo/plain.html', cwd);
ok('合规链：有效 -> PASSED', cA.status === 'PASSED', cA.message);
ok('合规链：失效 -> FAILED', cB.status === 'FAILED' && cC.status === 'FAILED', cB.message + ' | ' + cC.message);
ok('合规链：会话不在本机 -> PASSED 并注明跳过数', cD.status === 'PASSED' && cD.details.skipped === 1, cD.message);
ok('合规链：非 JS 文件 -> SKIPPED', cE.status === 'SKIPPED', cE.message);
ok('合规链：rule_id 与依据齐备', cA.rule_id === 'TRACE_NOTE_ANCHORS' && /check-trace-anchors/.test(cA.rule_source), cA.rule_source);
ok('合规链：FAILED 时 details 带上失效明细', cB.details.failures.length === 1, JSON.stringify(cB.details));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
