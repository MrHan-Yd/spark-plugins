#!/usr/bin/env node
// 测试替身：一个不说人话、只说 ACP 的 mock agent。
// 它存在的意义是让宿主可以在**离线、零依赖、不接真模型**的情况下被验证。
// 它故意做了两件事：
//   1) 用原设计文档里那几个不存在的方法名（tools/call、fs_patch）发一次请求，
//      用来证明宿主会立刻回 -32601 而不是静默挂起；
//   2) 写出一批"该被拦下"的文件（超 300 行 HTML、超 100 行内联 style、
//      语法坏掉的 JS、缺页面加固段的插件页面），用来验证合规评估器真的会红。
// stdout 是协议通道，所有日志走 stderr。
import path from 'node:path';

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const log = (...a) => process.stderr.write(`[mock-agent] ${a.join(' ')}\n`);

let nextId = 1;
const pending = new Map();

function request(method, params, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`宿主未在 ${timeoutMs}ms 内响应 ${method}`));
      }
    }, timeoutMs);
    pending.set(id, {
      method,
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

let sandbox = null;
let projectCwd = null;
let sessionId = 'session_placeholder';

function update(kind, extra) {
  notify('session/update', { sessionId, update: { kind, ...extra } });
}

function think(text) {
  update('agent_thought_chunk', { content: { type: 'text', text } });
}
function say(text) {
  update('agent_message_chunk', { content: { type: 'text', text } });
}

const abs = (p) => path.isAbsolute(p) ? p : path.join(sandbox, p);

// ── 故意的坏文件名与坏内容 ────────────────────────────────────────────────
function htmlOver300() {
  const lines = ['<!DOCTYPE html>', '<html lang="zh">', '<head>', '<meta charset="utf-8">', '<title>超长页面</title>', '<style>'];
  for (let i = 0; i < 8; i++) lines.push(`.r${i} { color: #333; }`);
  lines.push('</style>', '</head>', '<body>');
  for (let i = 0; i < 300; i++) lines.push(`  <div class="r${i % 8}">第 ${i} 行</div>`);
  lines.push('</body>', '</html>');
  return lines.join('\n');
}

function htmlInlineStyleOver100() {
  const lines = ['<!DOCTYPE html>', '<html lang="zh">', '<head>', '<style>'];
  for (let i = 0; i < 130; i++) lines.push(`.sel-${i} { margin: ${i}px; }`);
  lines.push('</style>', '</head>', '<body>', '<div class="sel-1">内联样式超阈值</div>', '</body>', '</html>');
  return lines.join('\n');
}

// 注意：node --check 会按最近的 package.json 决定模块类型，沙箱里没有 package.json，
// 所以 .js 按 CommonJS 解析 —— 想让语法检查通过就不能用 export。
const OK_JS = [
  '// 语法正确的小文件（CommonJS）',
  'const sum = (a, b) => a + b;',
  'module.exports = { sum };',
].join('\n');

const BROKEN_JS = [
  '// 故意写坏：参数表少一个右括号，node --check 应当报错',
  'function broken( {',
  '  return 1;',
  '}',
].join('\n');

// 页面加固段（照 hosts-switcher/0.1.0/page.js 的形态）
const HARDENED_PAGE_JS = [
  "/* ── 页面加固:屏蔽默认右键菜单与浏览器快捷键 ── */",
  "document.addEventListener('contextmenu', e => e.preventDefault());",
  "document.addEventListener('keydown', e => {",
  "  /* DevTools / 打印 / 刷新:任何焦点都拦(F12、F5、Ctrl+Shift+I/J/C、Ctrl+P) */",
  "  if (e.key === 'F12' || e.key === 'F5' || (e.ctrlKey && e.key === 'P')) e.preventDefault();",
  "});",
].join('\n');

const UNHARDENED_PAGE_JS = [
  '// 这个插件页面忘了加页面加固段',
  "document.querySelector('#go').addEventListener('click', () => {});",
].join('\n');

// 决策笔记样例（AGENTS.md §4 骨架）：一篇已落地、一篇被否决。
// 写进项目根的 .agents/notes/（不进沙箱）——验证宿主对受控目录外写盘的审批链与看板的笔记消费链。
const NOTE_IMPLEMENTED = [
  '# Agent Note: 追溯索引内联 diff 必须封顶',
  'Status: implemented',
  'Class: architecture',
  '',
  '## 背景',
  'index.json 会把每个会话的 diff 全部内联，供 HTTP 远程模式少发请求；但会话数 × diff 数线性增长。',
  '',
  '## 决策',
  '每会话内联条数封顶（DIFF_INLINE_MAX），超出只记 files.diffs 路径，看板按需回落读取；bundle 模式不受限。',
  '',
  '## 放弃方案',
  '完全不内联、全部按路径读取。它最省索引体积，但远程模式下每次展开 diff 都要多一次请求，弱网体验明显劣化。',
  '',
  '## 代价与后果',
  '索引体积上限变得可预期；代价是超出封顶的 diff 在远程模式下有额外一次往返，已用 diffs_inline_truncated 标记披露。',
].join('\n');

const NOTE_REJECTED = [
  '# Agent Note: 看板侧自动重试半截索引',
  'Status: rejected',
  'Class: architecture',
  '',
  '## 背景',
  '索引重建窗口内看板可能读到半截 JSON，最初想在看板载入失败时自动重试。',
  '',
  '## 决策',
  '否决自动重试；改为宿主侧原子写（tmp+rename），看板侧只提示可手动重试。',
  '',
  '## 放弃方案',
  '看板自动重试。它最强的理由是对用户零操作；但半截文件的持续时间不可预测，盲目重试只是把错误延迟，还可能掩盖宿主崩溃。',
  '',
  '## 代价与后果',
  '用户在极小概率的撞窗下要多点一次「重新载入」；换来生产端一次写盘即消灭整类竞态。',
  '替代方案落地见 [追溯索引内联 diff 必须封顶](../implemented/architecture/2026-09-16-trace-index-diff-inline-cap.md)。',
].join('\n');

// ── 一轮完整对话 ──────────────────────────────────────────────────────────
async function runTurn(promptId) {
  const outcome = [];

  think('先读仓库规则，再决定怎么改。');
  await request('fs/read_text_file', { sessionId, path: path.join(projectCwd, 'AGENTS.md'), limit: 8 });
  outcome.push('已读取 AGENTS.md 前 8 行');

  // 故意用错方法名：验证宿主不会挂起
  think('试一下原文档里写的 tools/call 和 fs_patch —— 按规范这两个名字应该有响应。');
  for (const bad of ['tools/call', 'fs_patch']) {
    try {
      await request(bad, { name: 'fs_patch', arguments: { path: 'x', diff: '@@' } }, 5000);
      outcome.push(`${bad} -> 宿主竟然接受了（不该发生）`);
    } catch (e) {
      outcome.push(`${bad} -> ${e.message}`);
    }
  }

  // 一批该被合规拦下的写盘
  const writes = [
    ['scratch/big-page.html', htmlOver300(), 'HTML 超 300 行'],
    ['scratch/inline-style.html', htmlInlineStyleOver100(), '内联 style 超 100 行'],
    ['scratch/ok.js', OK_JS, '语法正确的 JS'],
    [
      'scratch/ok.js',
      `${OK_JS}\n\n// 追加两行：用来产生一个真正带上下文的 hunk，而不是整文件新增\nconst diff = (a, b) => a - b;\nmodule.exports.diff = diff;\n`,
      '二次修改 ok.js（改已有文件）',
    ],
    ['scratch/broken.js', BROKEN_JS, '语法坏掉的 JS'],
    ['scratch/hardened-plugin/0.1.0/page.js', HARDENED_PAGE_JS, '带页面加固段的插件页面'],
    ['scratch/unhardened-plugin/0.1.0/page.js', UNHARDENED_PAGE_JS, '缺页面加固段的插件页面'],
  ];

  for (const [rel, content, why] of writes) {
    update('tool_call', { title: `fs/write_text_file ${rel}`, toolCallId: rel.replace(/\W/g, '_') });
    try {
      const res = await request('fs/write_text_file', { sessionId, path: abs(rel), content });
      outcome.push(`写盘 ${rel}（${why}）：已执行，Diff ${res?.diff_stat ?? 'n/a'}`);
    } catch (e) {
      outcome.push(`写盘 ${rel}（${why}）：被拒绝 —— ${e.message}`);
    }
  }

  // 决策笔记：绝对路径直指项目根 .agents/notes/，走同一条审批与合规链
  const noteWrites = [
    ['.agents/notes/implemented/architecture/2026-09-16-trace-index-diff-inline-cap.md', NOTE_IMPLEMENTED, '已落地的架构决策'],
    ['.agents/notes/rejected/architecture/2026-09-16-board-auto-retry.md', NOTE_REJECTED, '被否决的方案'],
  ];
  for (const [rel, content, why] of noteWrites) {
    update('tool_call', { title: `fs/write_text_file ${rel}`, toolCallId: rel.replace(/\W/g, '_') });
    try {
      await request('fs/write_text_file', { sessionId, path: path.join(projectCwd, rel), content });
      outcome.push(`写笔记 ${rel}（${why}）：已执行`);
    } catch (e) {
      outcome.push(`写笔记 ${rel}（${why}）：被拒绝 —— ${e.message}`);
    }
  }

  // 要跑命令 -> 必须过审批闸门
  think('跑一条 git status 核对工作区状态，这一步有副作用，应该触发审批。');
  const cmd = ['git', 'status', '--short', '--', '.'];
  try {
    const perm = await request('session/request_permission', {
      sessionId,
      toolCall: { title: `执行 ${cmd.join(' ')}`, kind: 'execute' },
      options: [
        { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
        { optionId: 'allow-always', name: '本轮都允许', kind: 'allow_always' },
        { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
      ],
    });
    const chosen = perm?.outcome?.optionId ?? null;
    outcome.push(`审批结果：${chosen ?? 'cancelled'}`);
    if (chosen && chosen.startsWith('allow')) {
      const t = await request('terminal/create', { sessionId, command: cmd, cwd: projectCwd });
      const exit = await request('terminal/wait_for_exit', { sessionId, terminalId: t.terminalId });
      const out = await request('terminal/output', { sessionId, terminalId: t.terminalId });
      await request('terminal/release', { sessionId, terminalId: t.terminalId });
      const firstLine = String(out?.output ?? '').trim().split('\n')[0] ?? '';
      outcome.push(`命令退出码 ${exit.exitCode}${firstLine ? `，首行：${firstLine}` : '（无输出）'}`);
    } else {
      outcome.push('命令未执行（用户拒绝）');
    }
  } catch (e) {
    outcome.push(`审批环节异常：${e.message}`);
  }

  say(`本轮结束。共 ${outcome.length} 个动作：\n- ${outcome.join('\n- ')}`);
  send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
}

// ── 协议入口 ──────────────────────────────────────────────────────────────
function handle(msg) {
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${msg.error.code} ${msg.error.message}`));
    else p.resolve(msg.result);
    return;
  }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'spark mock agent', version: '0.0.1' },
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, embeddedContext: true } },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    sessionId = `mock_${Date.now().toString(36)}`;
    projectCwd = msg.params?.cwd ?? process.cwd();
    sandbox = msg.params?._meta?.sparkTrace?.sandbox ?? process.cwd();
    log(`session/new: cwd=${projectCwd} sandbox=${sandbox}`);
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId } });
    return;
  }

  if (msg.method === 'session/prompt') {
    runTurn(msg.id).catch((e) => {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `mock agent 内部错误：${e.message}` } });
    });
    return;
  }

  if (msg.method === 'session/cancel') {
    log('收到 session/cancel');
    return;
  }

  log(`未处理的方法：${msg.method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`收到非 JSON 行：${line.slice(0, 80)}`);
      continue;
    }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
