/**
 * TRACE_WHY_ANCHORED（本次新增的"为什么"注释必须就近挂锚）的判定路径测试。
 *
 * 运行：node .agents/runner/tests/why-anchor-test.mjs
 *
 * 本文件以字符串形式包含 @anchors-skip / @see / @trace 等字样（fixture 用），
 * check-trace-anchors 按 SKIP_MARK 对整个文件跳过 —— 与 anchor-test.mjs 同款待遇，预期行为。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWhyAnchored, evaluateWrite } from '../compliance.mjs';

const cwd = process.cwd();
const tmp = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cases-why');
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

const REL = 'demo/why-cases/why.js'; // checkWhyAnchored 只用 rel 判定后缀/豁免，不读盘

// A) 新建文件（before 为空串）里的无锚 why 注释 → WARN，行号是新文件的行号
const why = [
  'export const a = 1;',
  '// 因为审批默认值跟 SPEC §4.3 对齐，这里不能拍脑袋写死',
  'export const b = 2;',
];
const ra = checkWhyAnchored(REL, why.join('\n'), '');
ok('新建文件的无锚 why 注释 -> WARN', ra.status === 'WARN' && ra.details.unanchored.length === 1, JSON.stringify(ra.details));
ok('unanchored 报告的是新文件行号', ra.details.unanchored[0].line === 2, JSON.stringify(ra.details.unanchored));
ok('WARN 不是 FAILED（不拦盘的合同）', ra.status === 'WARN', ra.status);
ok('rule_id 与 rule_source 齐备', ra.rule_id === 'TRACE_WHY_ANCHORED' && /AGENTS\.md §1/.test(ra.rule_source), ra.rule_source);

// B) 就近 3 行内挂了锚 -> PASSED
const anchored = [
  'export const a = 1;',
  '/**',
  ' * 因为审批默认值跟 SPEC §4.3 对齐，这里不能拍脑袋写死',
  ' * @see [SPEC](../../SPEC.md)',
  ' */',
  'export const b = 2;',
];
const rb = checkWhyAnchored(REL, anchored.join('\n'), '');
ok('就近 3 行内有锚 -> PASSED', rb.status === 'PASSED', rb.message);

// C) 只看新增：存量注释不追账
const withOldWhy = ['// 这句解释很早就在文件里，因为当初还没有挂锚的规范', 'export const c = 1;'];
const rc1 = checkWhyAnchored(REL, withOldWhy.join('\n'), '');
ok('before 为空的真新建场景：存量也算新增（会提醒）', rc1.status === 'WARN', rc1.message);
const rc2 = checkWhyAnchored(REL, withOldWhy.join('\n'), withOldWhy.join('\n'));
ok('存量注释本次未动 -> 不追账（宁可漏报）', rc2.status === 'PASSED', rc2.message);
const rc3 = checkWhyAnchored(REL, withOldWhy.join('\n'), 'export const c = 1;');
ok('本次新增的存量行 -> 照样提醒', rc3.status === 'WARN', rc3.message);

// D) 本次新增一条无锚 why 注释（改行也算新增）
const beforeD = ['export const d = 1;'];
const afterD = ['export const d = 1;', '// 否则会把审批闸绕过去，这是实测踩过的坑'];
const rd = checkWhyAnchored(REL, afterD.join('\n'), beforeD.join('\n'));
ok('本次新增无锚 why 注释 -> WARN', rd.status === 'WARN' && rd.details.why_lines === 1, rd.message);

// E) 短守卫注释（<8 字）不触发
const re = checkWhyAnchored(REL, ['export const e = 1;', '// 不能为空'], '');
ok('短守卫注释（<8 字）不触发', re.status === 'PASSED', re.message);

// F) 非 JS -> SKIPPED
const rf = checkWhyAnchored('demo/page.html', '<!-- 为什么不留锚 -->', '');
ok('非 JS 文件 -> SKIPPED', rf.status === 'SKIPPED', rf.message);

// G) @anchors-skip 声明 -> 整体跳过
const rg = checkWhyAnchored(REL, ['// @anchors-skip 文档样例文件', '// 因为没有锚也应当跳过'].join('\n'), '');
ok('@anchors-skip -> 整体 SKIPPED', rg.status === 'SKIPPED', rg.message);

// H) 追溯产物路径 -> SKIPPED（fixture 是数据不是被留痕的代码）
const rh = checkWhyAnchored('.agents/trace/s_x/sandbox/scratch/x.js', '// 因为测试脚手架不需要锚', '');
ok('追溯产物路径 -> SKIPPED', rh.status === 'SKIPPED', rh.message);

// I) evaluateWrite 集成链：规则已挂载；缺省 before 时宁可漏报（before 默认 content，零新增）
const p = write('integ.js', ['export const i = 1;', '// 因为集成链路要验证缺省 before 的行为', 'export const j = 2;']);
const ri = evaluateWrite({ absPath: p, content: fs.readFileSync(p, 'utf8'), cwd });
const whyRes = ri.find((r) => r.rule_id === 'TRACE_WHY_ANCHORED');
ok('evaluateWrite 已挂载新规则', Boolean(whyRes), JSON.stringify(ri.map((r) => r.rule_id)));
ok('缺省 before 时零误报（宁可漏报）', whyRes && whyRes.status === 'PASSED', whyRes && whyRes.message);
const ri2 = evaluateWrite({ absPath: p, content: fs.readFileSync(p, 'utf8'), cwd, before: 'export const i = 1;' });
const whyRes2 = ri2.find((r) => r.rule_id === 'TRACE_WHY_ANCHORED');
ok('evaluateWrite 传入 before 时能抓到新增未挂锚', whyRes2 && whyRes2.status === 'WARN', whyRes2 && whyRes2.message);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);