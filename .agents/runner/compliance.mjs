// 合规评估器（Linter Evaluators）
// 规则全部锚定本仓库 AGENTS.md 的真实小节，不发明编号：
//   §1 「ACP 规范·反向锚点」       -> 新增解释性注释必须就近挂 @trace / @see（WARN 级提示）
//   §2 「插件页面:样式与 JS 必须独立文件」-> 触发阈值（内联 style/script > 100 行，或 HTML > 300 行）
//   §2 提取做法第 4 条            -> 迁移后 JS 过 node --check
//   §3 「其它硬性约束」第 1 条     -> 新插件页面必须带「页面加固」段
//   §3 「发布物完整性」            -> git ls-files 条数 − 1 = signature.json 清单条数
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { countLines, splitLines, unifiedDiff } from './diff.mjs';
import { checkFile as checkAnchorsInFile, extractAnchors } from './check-trace-anchors.mjs';

const AGENTS_MD = 'AGENTS.md';

export const INLINE_LIMIT = 100;
export const HTML_LINE_LIMIT = 300;

/** 看板要能显示「当前挂载了哪些检查器」，所以规则元数据是可枚举的 */
export const RULES = [
  {
    rule_id: 'AGENTS_MD_SEC_2_EXTRACTION',
    rule_source: `${AGENTS_MD} §2 触发阈值`,
    trigger: 'agent 写 .html',
    detail: '内联 <style>/<script> 任一超 100 行，或 HTML 总行数超 300 行',
  },
  {
    rule_id: 'AGENTS_MD_SEC_2_SYNTAX',
    rule_source: `${AGENTS_MD} §2 提取做法第 4 条`,
    trigger: 'agent 写 .js/.mjs',
    detail: '跑 node --check 校验语法',
  },
  {
    rule_id: 'AGENTS_MD_SEC_3_HARDENING',
    rule_source: `${AGENTS_MD} §3 其它硬性约束第 1 条`,
    trigger: 'agent 写插件页面（index.html / page.*）',
    detail: '必须带页面加固段：禁右键菜单 + 拦 F12/F5/Ctrl+P/Ctrl+Shift+I|J|C',
  },
  {
    rule_id: 'TRACE_NOTE_ANCHORS',
    rule_source: `AGENTS.md §1 ACP 规范（留痕要求）+ check-trace-anchors.mjs 契约`,
    trigger: 'agent 写 .js/.mjs',
    detail: '代码里的 @see 文档锚点必须指向存在文件；@trace 会话#序号必须能在 .agents/trace 里找到（会话不在本机时跳过，不算失效）',
  },
  {
    rule_id: 'TRACE_WHY_ANCHORED',
    rule_source: `${AGENTS_MD} §1 ACP 规范·反向锚点`,
    trigger: 'agent 写 .js/.mjs',
    detail: 'WARN 级：本次新增的解释性注释（为什么/不能/只能/实测/踩坑/@deprecated 等）就近 3 行内没有 @trace 或 @see 时提示补挂；不拦盘、不计入合规失败',
  },
  {
    rule_id: 'AGENT_NOTE_FORMAT',
    rule_source: `${AGENTS_MD} §4 决策笔记`,
    trigger: 'agent 写 .agents/notes/**.md',
    detail: '路径即状态即分类（四 lifecycle × 六 class 枚举 + yyyy-mm-dd-主题命名）；骨架必须齐：# Agent Note 标题行、与目录一致的 Status/Class 行、四个必需小节（背景/决策/放弃方案/代价与后果）',
  },
  {
    rule_id: 'SPARK_RELEASE_INTEGRITY',
    rule_source: `${AGENTS_MD} §3 发布物完整性`,
    trigger: '--preflight <插件版本目录>',
    detail: 'git ls-files 条数 − 1（signature.json 自身）= signature.json 的 files 条数',
  },
];

function pass(rule_id, message, details = {}) {
  return { rule_id, rule_source: ruleOf(rule_id), status: 'PASSED', message, details };
}
function fail(rule_id, message, details = {}) {
  return { rule_id, rule_source: ruleOf(rule_id), status: 'FAILED', message, details };
}
function skip(rule_id, message, details = {}) {
  return { rule_id, rule_source: ruleOf(rule_id), status: 'SKIPPED', message, details };
}
/** WARN 只提示不拦截：trace.mjs 的汇总只数 FAILED，WARN 不会进 compliance_failed */
function warn(rule_id, message, details = {}) {
  return { rule_id, rule_source: ruleOf(rule_id), status: 'WARN', message, details };
}
function ruleOf(id) {
  return RULES.find((r) => r.rule_id === id)?.rule_source ?? '(unmapped)';
}

function relOf(absPath, cwd) {
  const rel = path.relative(cwd, absPath);
  return rel.split(path.sep).join('/');
}

/** 插件页面判定：路径里出现 <版本号>/(index|page).html 或 <版本号>/(app|page).js */
function isPluginPage(rel) {
  return /\d+\.\d+\.\d+\/(index|page)\.html$/.test(rel) || /\d+\.\d+\.\d+\/(app|page)\.js$/.test(rel);
}

/** §2 触发阈值 */
/**
 * 三件套提取阈值（AGENTS.md §2）：内联 <style>/<script> 任一超 100 行，或 HTML 总行数超 300 行。
 * 判定顺序是先看"是否适用"→ SKIPPED，再看阈值；同级命中多条时应当全部上报。
 *
 * @see [SPEC §6.1 规则表](SPEC.md#61-规则表rule_source-必须指向真实存在的小节)
 * @trace s_20260915-160059_c5828f#23 实测：这条 [Violation] 就是 319 行 HTML 触发的；同一次会话里三条阈值同时红
 */
export function checkExtraction(rel, content) {
  const base = path.basename(rel);
  if (!/\.html?$/i.test(rel)) {
    return skip('AGENTS_MD_SEC_2_EXTRACTION', `${base} 不是 HTML，阈值规则不适用`, { ext: path.extname(rel) });
  }
  const total = countLines(content);
  const inline = [];
  for (const tag of ['style', 'script']) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    for (const m of content.matchAll(re)) inline.push({ tag, lines: countLines(m[1]) });
  }
  const overLimit = inline.filter((b) => b.lines > INLINE_LIMIT);
  const details = { total_lines: total, html_line_limit: HTML_LINE_LIMIT, inline_blocks: inline, inline_limit: INLINE_LIMIT };

  if (overLimit.length) {
    const b = overLimit[0];
    return fail(
      'AGENTS_MD_SEC_2_EXTRACTION',
      `[Violation] ${base} 内联 <${b.tag}> 达 ${b.lines} 行（阈值 ${INLINE_LIMIT}），必须提取为独立文件`,
      details,
    );
  }
  if (total > HTML_LINE_LIMIT) {
    return fail(
      'AGENTS_MD_SEC_2_EXTRACTION',
      `[Violation] ${base} Exceeds ${HTML_LINE_LIMIT} lines, extract JS/CSS required.`,
      details,
    );
  }
  return pass('AGENTS_MD_SEC_2_EXTRACTION', `${base} ${total} 行，内联块均未超阈值`, details);
}

/** §2 提取做法第 4 条：node --check */
export function checkSyntax(absPath, rel) {
  if (!/\.(m|c)?js$/i.test(rel)) {
    return skip('AGENTS_MD_SEC_2_SYNTAX', `${path.basename(rel)} 不是 JS，node --check 不适用`, {});
  }
  const r = spawnSync(process.execPath, ['--check', absPath], { encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.error) {
    return fail('AGENTS_MD_SEC_2_SYNTAX', `node --check 无法执行：${r.error.message}`, {});
  }
  if (r.status === 0) {
    return pass('AGENTS_MD_SEC_2_SYNTAX', `node --check ${path.basename(rel)} 通过`, { command: 'node --check', exit_code: 0, output: out });
  }
  return fail('AGENTS_MD_SEC_2_SYNTAX', `node --check ${path.basename(rel)} 失败`, {
    command: 'node --check',
    exit_code: r.status,
    output: out.split('\n').slice(0, 12).join('\n'),
  });
}

/** §3 页面加固 */
export function checkHardening(rel, content) {
  if (!isPluginPage(rel)) {
    return skip('AGENTS_MD_SEC_3_HARDENING', `${path.basename(rel)} 不是插件页面，加固规则不适用`, {});
  }
  const markers = {
    contextmenu: /addEventListener\(\s*['"]contextmenu['"]/.test(content) || /oncontextmenu/i.test(content),
    devtools_keys: /F12/.test(content) || /keyCode\s*===\s*123/.test(content),
    print_block: /Ctrl\+P/i.test(content) || /key\s*===\s*['"]p['"]/i.test(content),
    refresh_block: /F5/.test(content),
  };
  const missing = Object.entries(markers).filter(([, v]) => !v).map(([k]) => k);
  if (!missing.length) {
    return pass('AGENTS_MD_SEC_3_HARDENING', '页面加固段齐备：禁右键菜单 + 拦 F12/F5/Ctrl+P', { markers });
  }
  return fail('AGENTS_MD_SEC_3_HARDENING', `页面加固段缺失：${missing.join(', ')}`, { markers, missing });
}

/** 反向锚点：代码里的 @see / @trace 必须解析得开，否则"当初为什么这么写"就断了 */
export function checkTraceAnchors(absPath, rel, cwd) {
  if (!/\.(m|c)?js$/i.test(rel)) {
    return skip('TRACE_NOTE_ANCHORS', `${path.basename(rel)} 不是 JS，锚点规则不适用`, {});
  }
  let res;
  try {
    res = checkAnchorsInFile({ absPath, cwd });
  } catch (e) {
    return fail('TRACE_NOTE_ANCHORS', `锚点校验自身失败：${e.message}`, {});
  }
  const details = {
    anchors: res.anchors.length,
    resolved: res.ok.length,
    skipped: res.skipped.length,
    failures: res.failures.map((f) => ({ line: f.line, raw: f.raw, reason: f.reason })),
  };
  if (!res.anchors.length) {
    return skip('TRACE_NOTE_ANCHORS', '这个文件里没有反向锚点', details);
  }
  if (res.failures.length) {
    return fail('TRACE_NOTE_ANCHORS', `${res.failures.length} 个锚点失效（第 ${res.failures.map((f) => f.line).join(', ')} 行）`, details);
  }
  return pass(
    'TRACE_NOTE_ANCHORS',
    `${res.anchors.length} 个锚点全部解析${res.skipped.length ? `（${res.skipped.length} 个追溯坐标因会话不在本机而跳过）` : ''}`,
    details,
  );
}

/**
 * 反向锚点的"自觉"闸（AGENTS.md §1 反向锚点）：本次**新增**的解释性决策注释必须就近挂 @trace / @see。
 * 锚点必须是写码会话内顺手挂的——事后考古要翻整个 trace 库，这条规则就是把"别留到以后"变成机械提醒。
 * 只看新增行（before/after 逐行 diff），存量注释不管，否则改造旧文件时会被历史欠账刷屏。
 * before 缺省等于 content：diff 为空 → 零提醒；宁可漏报也不把存量欠账算到本次头上。
 *
 * @see [SPEC §5.6 反向锚点：代码 → 追溯记录](SPEC.md#56-反向锚点代码--追溯记录)
 * @see [SPEC §6.2 状态枚举](SPEC.md#62-状态枚举五种v1-只有一种)
 */
export function checkWhyAnchored(rel, content, before = content) {
  const base = path.basename(rel);
  if (!/\.(m|c)?js$/i.test(rel)) {
    return skip('TRACE_WHY_ANCHORED', `${base} 不是 JS，注释锚点规则不适用`, {});
  }
  if (ANCHOR_SKIP_MARK.test(content)) {
    return skip('TRACE_WHY_ANCHORED', `${base} 声明了锚点豁免标记，整体跳过`, {});
  }
  // 追溯产物自身（events/diffs/sandbox fixture）是数据不是被留痕的代码
  if (/^\.agents\/trace\//.test(rel.replace(/\\/g, '/'))) {
    return skip('TRACE_WHY_ANCHORED', '追溯产物不参与挂锚', {});
  }
  const addedLines = [];
  for (const hunk of unifiedDiff(String(before), String(content)).hunks) {
    let lineNo = hunk.new_start;
    for (const l of hunk.lines) {
      if (l.type === '+') {
        if (isWhyComment(l.text)) addedLines.push({ line: lineNo, text: l.text.trim() });
        lineNo++;
      } else if (l.type === ' ') {
        lineNo++;
      }
    }
  }
  if (!addedLines.length) {
    return pass('TRACE_WHY_ANCHORED', '本次没有新增解释性注释（或均已挂锚）', { why_lines: 0 });
  }
  const anchorLines = extractAnchors(String(content)).map((a) => a.line);
  const PROXIMITY = 3;
  const unanchored = addedLines.filter((l) => !anchorLines.some((n) => Math.abs(n - l.line) <= PROXIMITY));
  if (!unanchored.length) {
    return pass('TRACE_WHY_ANCHORED', `新增 ${addedLines.length} 条解释性注释均已就近挂锚`, { why_lines: addedLines.length });
  }
  return warn(
    'TRACE_WHY_ANCHORED',
    `${unanchored.length} 条新增"为什么"注释未挂锚（第 ${unanchored.map((l) => l.line).join(', ')} 行）——写码会话内补 @trace/@see`,
    { why_lines: addedLines.length, unanchored: unanchored.map((l) => ({ line: l.line, text: l.text.slice(0, 80) })) },
  );
}

/** 强信号词表：只认这些，放宽会把普通字段注释刷屏 */
const WHY_MARKERS = /为什么|为何|因为|缘故|不能|不可能|只能|只好|否则|实测|踩坑|踩过|坑[:：]|被否决|不采纳|当初|本来|原本|@deprecated|hack|workaround|because|otherwise/i;

/** §4 决策笔记：路径与骨架的机械判定依据 */
export const NOTE_LIFECYCLES = ['proposed', 'implemented', 'rejected', 'archived'];
export const NOTE_CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'];
const NOTE_PATH_RE = new RegExp(`^\\.agents/notes/(${NOTE_LIFECYCLES.join('|')})/(${NOTE_CLASSES.join('|')})/(\\d{4}-\\d{2}-\\d{2})-.+\\.md$`);
const NOTE_SECTIONS = ['背景', '决策', '放弃方案', '代价与后果'];

/**
 * §4 决策笔记格式闸：路径即状态即分类，骨架四节齐备。
 * 只拦写进 .agents/notes/ 的 .md；其它路径的笔记式文件不归本规则管。
 *
 * @see [SPEC §6.1 规则表](SPEC.md#61-规则表rule_source-必须指向真实存在的小节)
 */
export function checkNoteFormat(rel, content) {
  const base = path.basename(rel);
  const norm = rel.replace(/\\/g, '/');
  if (!/^\.agents\/notes\/.+\.md$/.test(norm)) {
    return skip('AGENT_NOTE_FORMAT', `${base} 不是决策笔记，格式规则不适用`, {});
  }
  const m = norm.match(/^\.agents\/notes\/([^/]+)\/([^/]+)\/(.+)\.md$/);
  const details = { path: norm };
  if (!m || !NOTE_PATH_RE.test(norm)) {
    return fail('AGENT_NOTE_FORMAT', `[Violation] ${base} 路径必须是 {lifecycle}/{class}/yyyy-mm-dd-主题.md（枚举见 AGENTS.md §4.2）`, details);
  }
  const lifecycle = m[1];
  const cls = m[2];
  details.lifecycle = lifecycle;
  details.class = cls;
  const text = String(content ?? '');
  const status = text.match(/^Status:\s*(\S+)\s*$/m);
  const klass = text.match(/^Class:\s*(\S+)\s*$/m);
  const missing = [];
  if (!text.match(/^#\s*Agent Note:/m)) missing.push('# Agent Note 标题行');
  if (!status || status[1] !== lifecycle) missing.push(`Status: 行（应为 ${lifecycle}）`);
  if (!klass || klass[1] !== cls) missing.push(`Class: 行（应为 ${cls}）`);
  for (const sec of NOTE_SECTIONS) {
    if (!text.match(new RegExp(`^##\\s*${sec}\\s*$`, 'm'))) missing.push(`## ${sec}`);
  }
  if (missing.length) {
    return fail('AGENT_NOTE_FORMAT', `[Violation] ${base} 笔记骨架缺失：${missing.join('、')}`, details);
  }
  return pass('AGENT_NOTE_FORMAT', `${base} 骨架齐备（${lifecycle}/${cls}）`, details);
}

/** 锚点豁免标记。字面量整写进源码会被校验器按文件文本命中，把本文件整体豁免——自己的锚点就没人校验了，所以拆开拼 */
const ANCHOR_SKIP_MARK = new RegExp('@anch' + 'ors-skip\\b');

function isWhyComment(text) {
  const m = String(text).trim().match(/^(?:\/\/|\/\*\*?|\*)\s*(.*)$/);
  if (!m) return false; // 非注释行不算
  const body = m[1];
  if (body.length < 8) return false; // "不能为空"这类短守卫不算
  return WHY_MARKERS.test(body);
}

/** 写盘时把与该文件相关的评估器全跑一遍 */
export function evaluateWrite({ absPath, content, cwd, before }) {
  const rel = relOf(absPath, cwd);
  return [
    checkExtraction(rel, content),
    checkSyntax(absPath, rel),
    checkHardening(rel, content),
    checkTraceAnchors(absPath, rel, cwd),
    checkWhyAnchored(rel, content, before),
    checkNoteFormat(rel, content),
  ];
}

/** §3 发布物完整性：N-1 核对 */
export function runPreflight({ pluginDir, cwd }) {
  const abs = path.resolve(cwd, pluginDir);
  const sigPath = path.join(abs, 'signature.json');
  if (!fs.existsSync(sigPath)) {
    return fail('SPARK_RELEASE_INTEGRITY', `${pluginDir} 下没有 signature.json`, { plugin_dir: pluginDir });
  }
  let manifestCount;
  try {
    const sig = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
    manifestCount = Array.isArray(sig.files) ? sig.files.length : null;
  } catch (e) {
    return fail('SPARK_RELEASE_INTEGRITY', `signature.json 解析失败：${e.message}`, { plugin_dir: pluginDir });
  }
  const r = spawnSync('git', ['ls-files', pluginDir.replace(/\\/g, '/')], { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    return fail('SPARK_RELEASE_INTEGRITY', `git ls-files 执行失败：${(r.error?.message ?? r.stderr ?? '').trim()}`, {});
  }
  const tracked = r.stdout.split('\n').filter(Boolean);
  const expected = tracked.length - 1; // 减去 signature.json 自身
  const details = {
    plugin_dir: pluginDir,
    git_tracked: tracked.length,
    minus_signature_self: expected,
    manifest_entries: manifestCount,
    tracked_files: tracked.map((p) => p.split('/').pop()),
  };
  if (expected === manifestCount) {
    return pass('SPARK_RELEASE_INTEGRITY', `signature.json 清单 ${manifestCount} 条 = git 追踪 ${tracked.length} − 1，一致`, details);
  }
  return fail(
    'SPARK_RELEASE_INTEGRITY',
    `数量不一致：git 追踪 ${tracked.length} − 1 = ${expected}，但 signature.json 清单 ${manifestCount} 条`,
    details,
  );
}

/** 审批闸门用的风险判定：有副作用的才拦 */
export function classifyRisk(method, params) {
  // agent 主动申请授权：风险要从它想干的事情上读，而不是看方法名
  if (method === 'session/request_permission') {
    const kind = String(params?.toolCall?.kind ?? '');
    const title = String(params?.toolCall?.title ?? '');
    const heavy = kind === 'execute' || /(git\s+(commit|push)|rm\s|del\s|cargo\s|npm\s|pnpm\s|make\s|执行)/i.test(title);
    return { risk: heavy ? 'HIGH' : 'MEDIUM', reason: `agent 申请授权：${title || kind || '(未命名)'}` };
  }
  if (method === 'fs/write_text_file') {
    return { risk: 'HIGH', reason: `写磁盘：${path.basename(String(params?.path ?? ''))}` };
  }
  if (method === 'terminal/create') {
    const cmd = Array.isArray(params?.command) ? params.command.join(' ') : String(params?.command ?? '');
    const heavy = /(^|\s)(git\s+(commit|push)|rm|del|format|cargo|npm|pnpm|yarn|make)\b/i.test(cmd);
    return { risk: heavy ? 'HIGH' : 'MEDIUM', reason: `执行命令：${cmd}` };
  }
  if (method === 'fs/read_text_file') return { risk: 'LOW', reason: '只读' };
  return { risk: 'LOW', reason: '无已知副作用' };
}

export { splitLines };
