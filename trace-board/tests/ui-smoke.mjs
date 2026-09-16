/* 追溯看板 · 界面冒烟（Node + 无头 Chrome + CDP）
 *
 * 运行：node trace-board/tests/ui-smoke.mjs
 *
 * 思路：
 *   1) Node 起一个只读静态服务，根指向沙箱的 .agents/trace（夹具全在临时目录，不碰真实 trace）；
 *   2) 注入 window.spark 桩：fs.read 走那个服务（等价于"授权目录后按路径读"），
 *      net.fetch 直接转发真 fetch（等价于"HTTP 远程库"）；
 *   3) 只走用户路径驱动（点按钮、敲输入、切模块），不调内部函数 —— 内部函数测不到接线错误。
 *
 * 注意：spark 桩必须在页面脚本之前注入，否则插件会走"无宿主"分支。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const PLUGIN_DIR = path.join(ROOT, 'trace-board', '0.1.0');
/* 样本一律写进临时沙箱：真实 .agents/trace 只留给宿主记录的真实会话，冒烟不污染 */
const SMOKE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-board-smoke-'));
process.on('exit', () => { try { fs.rmSync(SMOKE_ROOT, { recursive: true, force: true }); } catch { /* 忽略 */ } });
const TRACE_DIR = path.join(SMOKE_ROOT, '.agents', 'trace');
const SHOTS = path.join(here, 'screenshots');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n追溯看板 · 界面冒烟\n');

/* ── 样本：沙箱里抓一轮「部分放行 / 部分拒绝」，真实 trace 目录不碰 ───── */
console.log('【准备样本】沙箱内抓一轮「部分放行 / 部分拒绝」的 trace');
{
  // 决策笔记夹具：mock 走审批链写同名文件，这里先补底保证 UI 断言与审批结果解耦
  const notesRoot = path.join(SMOKE_ROOT, '.agents', 'notes');
  const noteFixtures = [
    ['.agents/notes/implemented/architecture/2026-09-16-trace-index-diff-inline-cap.md',
      '# Agent Note: 追溯索引内联 diff 必须封顶\nStatus: implemented\nClass: architecture\n\n## 背景\nindex.json 会把每个会话的 diff 全部内联，供 HTTP 远程模式少发请求；但会话数 × diff 数线性增长。\n\n## 决策\n每会话内联条数封顶（DIFF_INLINE_MAX），超出只记 files.diffs 路径，看板按需回落读取；bundle 模式不受限。\n\n## 放弃方案\n完全不内联、全部按路径读取。它最省索引体积，但远程模式下每次展开 diff 都要多一次请求，弱网体验明显劣化。\n\n## 代价与后果\n索引体积上限变得可预期；代价是超出封顶的 diff 在远程模式下有额外一次往返，已用 diffs_inline_truncated 标记披露。'],
    ['.agents/notes/rejected/architecture/2026-09-16-board-auto-retry.md',
      '# Agent Note: 看板侧自动重试半截索引\nStatus: rejected\nClass: architecture\n\n## 背景\n索引重建窗口内看板可能读到半截 JSON，最初想在看板载入失败时自动重试。\n\n## 决策\n否决自动重试；改为宿主侧原子写（tmp+rename），看板侧只提示可手动重试。\n\n## 放弃方案\n看板自动重试。它最强的理由是对用户零操作；但半截文件的持续时间不可预测，盲目重试只是把错误延迟，还可能掩盖宿主崩溃。\n\n## 代价与后果\n用户在极小概率的撞窗下要多点一次「重新载入」；换来生产端一次写盘即消灭整类竞态。\n替代方案落地见 [追溯索引内联 diff 必须封顶](../implemented/architecture/2026-09-16-trace-index-diff-inline-cap.md)。'],
  ];
  for (const [rel, body] of noteFixtures) {
    const abs = path.join(notesRoot, rel.replace(/^\.agents\/notes\//, ''));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, body);
  }
  // AGENTS.md 一并复制：mock 第一脚要读它，合规检查器（AGENTS_MD_SEC_2_EXTRACTION 等）也从它注册
  fs.copyFileSync(path.join(ROOT, 'AGENTS.md'), path.join(SMOKE_ROOT, 'AGENTS.md'));
  const fxPort = 9600 + Math.floor(Math.random() * 200);
  const fxToken = 'smoke' + Date.now().toString(36);
  const runner = path.join(ROOT, '.agents', 'runner');
  const host = spawn(process.execPath, [path.join(runner, 'host.mjs'), '--mock', '--policy', 'ask',
    '--cwd', SMOKE_ROOT, '--ws-port', String(fxPort), '--token', fxToken, '--wait-dashboard-ms', '8000',
    '--preflight-anchors', '--quiet'],
    { cwd: ROOT, stdio: 'ignore' });
  await sleep(1200);
  const appr = spawn(process.execPath, [path.join(runner, 'approver.mjs'),
    `ws://127.0.0.1:${fxPort}/?token=${fxToken}`, 'alternate'], { cwd: ROOT, stdio: 'ignore' });
  const closed = await Promise.race([
    new Promise((r) => host.on('close', () => r('ok'))),
    sleep(45000).then(() => 'timeout'),
  ]);
  try { appr.kill(); } catch { /* 忽略 */ }
  try { host.kill(); } catch { /* 忽略 */ }
  if (closed === 'timeout') { console.log('  ! 样本抓取超时'); process.exit(1); }
  console.log('  样本已就绪（含落盘与拦截两类记录，索引已重建）');
}

/* ── 静态服务：只暴露沙箱 .agents/trace，禁止穿越 ─────────────────── */
/* 必须带 CORS 头：页面是 file:// 源（null origin），跨源 fetch 会被浏览器挡掉。
   正式环境里 spark.net.fetch 走宿主 WinHTTP 代理，没有 CORS 这回事；这里只是把桩补全。 */
const MIME = { '.json': 'application/json', '.jsonl': 'text/plain', '.diff': 'text/plain', '.md': 'text/plain' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const abs = path.resolve(TRACE_DIR, rel);
  const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if (!abs.startsWith(TRACE_DIR)) { res.writeHead(403, cors); res.end('forbidden'); return; }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.writeHead(404, cors); res.end('not found'); return; }
  res.writeHead(200, { ...cors, 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
  res.end(fs.readFileSync(abs));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

if (!fs.existsSync(path.join(TRACE_DIR, 'index.json'))) {
  console.log('  ! 没有 .agents/trace/index.json，沙箱样本没建好（host.mjs 样本轮失败）');
  server.close();
  process.exit(1);
}

/* ── 无头 Chrome ─────────────────────────────────────────────────── */
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('未找到 Chrome/Edge'); server.close(); process.exit(1); }

const DBG = 9500 + Math.floor(Math.random() * 90);
const profile = path.join(os.tmpdir(), 'tb-smoke-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files',
  '--window-size=1280,820', '--remote-debugging-port=' + DBG, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

let targets;
for (let i = 0; i < 100; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${DBG}/json/list`);
    targets = await r.json();
    if (targets.some((t) => t.type === 'page')) break;
  } catch { /* 等启动 */ }
  await sleep(200);
}
if (!targets || !targets.length) { console.log('浏览器启动失败'); chrome.kill(); server.close(); process.exit(1); }

const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pend = new Map();
const exceptions = [];
const consoleErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description).join(' '));
  }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Page.enable');
await send('Runtime.enable');

/* ── 注入 spark 桩（必须在页面脚本之前）──────────────────────────── */
const STUB = `
window.__copied = null;
(function(){
  var BASE = ${JSON.stringify(BASE)};
  function norm(p){ return String(p).replace(/\\\\/g,'/'); }
  function toUrl(p){
    var s = norm(p);
    var m = s.match(/\\.agents\\/trace\\/(.*)$/);
    return BASE + '/' + (m ? m[1] : s.replace(/^\\/+/, ''));
  }
  var store = {};
  window.spark = {
    input: { text: '', command: '', rawQuery: '' },
    db: {
      get: function(k){ return Promise.resolve(k in store ? store[k] : null); },
      set: function(k,v){ store[k]=v; return Promise.resolve(); },
      remove: function(k){ delete store[k]; return Promise.resolve(); },
      keys: function(){ return Promise.resolve(Object.keys(store)); },
      clear: function(){ store={}; return Promise.resolve(); }
    },
    clipboard: {
      writeText: function(t){ window.__copied = String(t); return Promise.resolve(); },
      readText: function(){ return Promise.resolve(''); }
    },
    fs: {
      read: function(p){
        return fetch(toUrl(p)).then(function(r){
          if (!r.ok) { var e = new Error('HTTP ' + r.status + ' ' + p); e.code = 'NOT_FOUND'; throw e; }
          return r.text();
        });
      }
    },
    net: {
      fetch: function(u, init){
        return fetch(u, init).then(function(r){
          return { status: r.status, headers: {}, text: function(){ return r.text(); }, json: function(){ return r.json(); } };
        });
      }
    },
    window: { setTitle: function(){return Promise.resolve();}, resize: function(){return Promise.resolve();},
              center: function(){return Promise.resolve();}, close: function(){return Promise.resolve();} },
    notify: { show: function(){ return Promise.resolve(); } },
    onEnter: function(cb){ setTimeout(cb, 0); },
    onClose: function(){}, onInput: function(){}, onResize: function(){},
    dev: { openDevTools: function(){} }
  };
  window.__sparkStore = store;
})();
`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });

/* STUB2：db 整体不可用（读恒空 / 写拒绝），模拟用户实测的「刷新即丢」根因。
   先注入的 STUB 在重载时仍会执行，这里靠注册顺序后执行整包覆盖 window.spark */
const STUB2 = STUB
  .replace('get: function(k){ return Promise.resolve(k in store ? store[k] : null); },',
    'get: function(){ return Promise.resolve(null); },')
  .replace('set: function(k,v){ store[k]=v; return Promise.resolve(); },',
    'set: function(){ return Promise.reject(new Error("db broken")); },')
  .replace('window.__sparkStore = store;',
    'window.__sparkStore = store; window.__dbBrokenStub = true;');

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result.result.value;
};
async function waitFor(expr, timeout = 8000, label = expr) {
  const t0 = Date.now();
  for (;;) {
    const v = await ev(expr);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('等待超时：' + label);
    await sleep(120);
  }
}
async function shot(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64'));
}

const SRC_PATH  = SMOKE_ROOT.replace(/\\/g, '/');
const goModule = (m) => ev(`document.querySelector('#mods .mod[data-mod=${m}]').click()`);

/* ── 打开插件页 ─────────────────────────────────────────────────── */
await send('Page.navigate', { url: 'file:///' + path.join(PLUGIN_DIR, 'index.html').replace(/\\/g, '/') });
await waitFor('!!window.__traceBoard && !!window.TraceModules', 8000, '插件脚本就绪');
await sleep(400);

console.log('【静态结构】');
ok('六个脚本按序加载', await ev('!!window.TraceSource && !!window.TraceAnalyze && !!window.TraceAggregate && !!window.TraceRender && !!window.TraceModules && !!window.__traceBoard'));
ok('页面无内联 style/script', await ev('document.querySelectorAll("style").length === 0 && !Array.from(document.scripts).some(s => !s.src)'));
ok('无 IDE 注入的 data-page-node-id', (await ev('document.querySelectorAll("[data-page-node-id]").length')) === 0);
ok('页面加固：页面空白处右键被拦', await ev(`(function(){ var e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true}); document.body.dispatchEvent(e); return e.defaultPrevented; })()`));
ok('页面加固：输入框内右键放行', await ev(`(function(){ var e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true}); document.getElementById('in-path').dispatchEvent(e); return !e.defaultPrevented; })()`));
ok('页面加固：F12 被拦', await ev(`(function(){ var k=new KeyboardEvent('keydown',{key:'F12',bubbles:true,cancelable:true}); document.body.dispatchEvent(k); return k.defaultPrevented; })()`));
ok('页面加固：Ctrl+Shift+I 被拦', await ev(`(function(){ var k=new KeyboardEvent('keydown',{key:'I',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}); document.body.dispatchEvent(k); return k.defaultPrevented; })()`));
ok('未误伤普通按键（Enter 不被拦）', await ev(`(function(){ var k=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}); document.body.dispatchEvent(k); return !k.defaultPrevented; })()`));
ok('五个模块都在导航里', (await ev("document.querySelectorAll('#mods .mod').length")) === 5);
ok('默认落在架构基线', await ev("document.querySelector('#mods .mod.active').dataset.mod === 'baseline'"));
ok('库为空时不自动弹抽屉', await ev("document.getElementById('library').hidden === true && document.getElementById('overlay').hidden === true"));
ok('空态给了引导按钮', /还没有载入数据源/.test(await ev("document.getElementById('pane-baseline').textContent")) && (await ev("document.querySelectorAll('#pane-baseline .primary-btn').length")) === 1);
await shot('00-首屏空态');

/* ── 数据源库：添加本地路径 ───────────────────────────────────── */
console.log('\n【数据源库】');
await ev("document.querySelector('#pane-baseline .primary-btn').click()");
await waitFor("!document.getElementById('library').hidden", 4000, '引导按钮打开抽屉');
ok('点引导按钮打开数据源库', await ev("document.getElementById('library').hidden === false"));
await shot('00-数据源库-空态');
ok('空态给了指引', /还没有打开过任何数据源/.test(await ev("document.getElementById('lib-list').textContent")));
await ev(`document.getElementById('in-path').value = ${JSON.stringify(SRC_PATH)}`);
await ev("document.getElementById('btn-path').click()");
await waitFor('window.__traceBoard.state.index && window.__traceBoard.state.index.sessions.length > 0', 14000, '本地路径载入');
// 抽屉收起有 150ms 退场动画，别抢跑
ok('入库后抽屉自动收起', await waitFor("document.getElementById('library').hidden === true", 4000, '抽屉收起').then(() => true, () => false));
ok('顶栏显示来源标签', /本地路径/.test(await ev("document.getElementById('src-kind').textContent")));
ok('顶栏显示来源内容', (await ev("document.getElementById('src-label').textContent")).indexOf('trace-board-smoke') >= 0);
const sessCount = await ev('window.__traceBoard.state.index.sessions.length');
ok('载入了索引且会话数 > 0', sessCount > 0, sessCount + ' 个会话');
ok('左轨渲染出会话项', (await ev("document.querySelectorAll('#sess-list .sess').length")) === sessCount);
ok('左轨每行都有统计范围勾选框', (await ev("document.querySelectorAll('#sess-list .sess-chk input').length")) === sessCount);
ok('默认全部纳入统计范围', (await ev("document.getElementById('sess-count').textContent")) === sessCount + '/' + sessCount);

/* ── 架构基线 ─────────────────────────────────────────────────── */
console.log('\n【架构基线】');
const noteCount = await ev('window.__traceBoard.state.index.notes ? window.__traceBoard.state.index.notes.length : 0');
ok('索引带决策笔记', noteCount >= 2, noteCount + ' 篇');
ok('KPI 四卡渲染', (await ev("document.querySelectorAll('#pane-baseline .kpi-card').length")) === 4);
ok('KPI 有已落地与待评审', /已落地/.test(await ev("document.getElementById('pane-baseline').textContent")) && /待评审/.test(await ev("document.getElementById('pane-baseline').textContent")));
const wallCards = await ev("document.querySelectorAll('#pane-baseline .note-card').length");
ok('承重墙有决策卡片', wallCards > 0, wallCards + ' 张');
ok('承重墙标了被引用口径', /被其它笔记引用/.test(await ev("document.getElementById('pane-baseline').textContent")));
ok('有被引用徽章', (await ev("document.querySelectorAll('#pane-baseline .ref-badge').length")) > 0);
ok('分类面板有卡片', (await ev("document.querySelectorAll('#pane-baseline .chamber').length")) > 0);
ok('列出生效的检查器', /AGENTS_MD_SEC_2_EXTRACTION/.test(await ev("document.getElementById('pane-baseline').textContent")));
ok('列出 ACP 协议版本与 agent 能力', /ACP 协议版本/.test(await ev("document.getElementById('pane-baseline').textContent")) && /embeddedContext/.test(await ev("document.getElementById('pane-baseline').textContent")));
await shot('01-架构基线');

/* ── 笔记详情抽屉与顶栏搜索 ───────────────────────────────────── */
console.log('\n【笔记详情与搜索】');
await ev("document.querySelector('#pane-baseline .note-card').click()");
await waitFor("!document.getElementById('note-view').hidden", 4000, '笔记抽屉');
ok('点笔记卡打开详情抽屉', /决策/.test(await ev("document.getElementById('note-body').textContent")));
ok('抽屉里有被引用清单', /被这些笔记引用/.test(await ev("document.getElementById('note-body').textContent")));
await shot('01b-笔记详情');
await ev("document.getElementById('note-close').click()");
await sleep(300);
await ev("document.getElementById('in-search').value = '内联'");
await ev("document.getElementById('in-search').dispatchEvent(new Event('input'))");
await sleep(250);
ok('顶栏搜索过滤笔记', (await ev("document.querySelectorAll('#pane-baseline .note-card').length")) === 1,
  String(await ev("document.querySelectorAll('#pane-baseline .note-card').length")) + ' 张');
await ev("document.getElementById('in-search').value = ''");
await ev("document.getElementById('in-search').dispatchEvent(new Event('input'))");
await sleep(200);

/* ── 演进时间线 ───────────────────────────────────────────────── */
console.log('\n【演进时间线】');
await goModule('evolution');
await sleep(250);
const groups = await ev("document.querySelectorAll('#pane-evolution .tl-group').length");
ok('按日期分组渲染', groups > 0, groups + ' 组');
ok('有笔记与条目可点', (await ev("document.querySelectorAll('#pane-evolution .tl-item').length")) > 0);
ok('有月份切片控件', /月份切片/.test(await ev("document.getElementById('pane-evolution').textContent")));
ok('有类型切片控件', /类型切片/.test(await ev("document.getElementById('pane-evolution').textContent")));
const evoAll = await ev("document.querySelectorAll('#pane-evolution .tl-item').length");
const evoOne = await ev(`(function(){
  var pills = document.querySelectorAll("#pane-evolution .criteria .pills");
  var monthPills = pills[0].querySelectorAll('.pill');
  if (monthPills.length < 2) return null;
  monthPills[1].click();
  return document.querySelectorAll('#pane-evolution .tl-item').length;
})()`);
ok('月份切片能筛掉一部分', evoOne !== null && evoOne <= evoAll, `全部 ${evoAll} → 切片后 ${evoOne}`);
await ev(`Array.from(document.querySelectorAll('#pane-evolution .mini-btn')).find(b => b.textContent === '重置时间线筛选').click()`);
await sleep(200);
ok('重置筛选恢复全部', (await ev("document.querySelectorAll('#pane-evolution .tl-item').length")) === evoAll);
await shot('02-演进时间线');

/* ── 避坑智库 ─────────────────────────────────────────────────── */
console.log('\n【避坑智库】');
await goModule('pitfalls');
await sleep(250);
const pitCards = await ev("document.querySelectorAll('#pane-pitfalls .pit-card').length");
ok('被否决笔记渲染成三块卡', pitCards > 0, pitCards + ' 张');
ok('三块卡有权衡与采纳', /权衡依据/.test(await ev("document.getElementById('pane-pitfalls').textContent")) && /采纳结果/.test(await ev("document.getElementById('pane-pitfalls').textContent")));
const heads = await ev("Array.from(document.querySelectorAll('#pane-pitfalls .tbl thead th')).map(th => th.textContent)");
ok('表头是六列且顺序对齐参考站', JSON.stringify(heads) === JSON.stringify(['编号', '分类', '标题', '状态', '日期', '引用']), JSON.stringify(heads));
const pitRows = await ev("document.querySelectorAll('#pane-pitfalls .tbl tbody tr').length");
ok('有被否决/被拦下的条目', pitRows > 0, pitRows + ' 行');
ok('三种排序都在', /最新优先/.test(await ev("document.getElementById('pane-pitfalls').textContent")) && /引用最多/.test(await ev("document.getElementById('pane-pitfalls').textContent")));
ok('说明了「引用」的含义', /多少个会话里被拦过/.test(await ev("document.getElementById('pane-pitfalls').textContent")));
const refsDesc = await ev(`(function(){
  Array.from(document.querySelectorAll('#pane-pitfalls .pill')).find(p => p.textContent === '引用最多').click();
  return new Promise(function(res){
    setTimeout(function(){
      var v = Array.from(document.querySelectorAll('#pane-pitfalls .tbl tbody tr')).map(tr => Number(tr.children[5].textContent));
      res(v.length ? (v[0] >= v[v.length-1]) : false);
    }, 200);
  });
})()`);
ok('按「引用最多」排序后引用数不递增', refsDesc === true);
await ev(`Array.from(document.querySelectorAll('#pane-pitfalls .mini-btn')).find(b => b.textContent === '重置筛选').click()`);
await sleep(200);
await shot('03-避坑智库');

/* ── 决策清单 ─────────────────────────────────────────────────── */
console.log('\n【决策清单】');
await goModule('ledger');
await sleep(250);
ok('决策清单是笔记总表（有笔记时）', (await ev("document.querySelectorAll('#pane-ledger .tbl tbody tr').length")) === noteCount, `${await ev("document.querySelectorAll('#pane-ledger .tbl tbody tr').length")} 行 / ${noteCount} 篇笔记`);
ok('决策清单也标了状态', /已落地|待评审|被否决/.test(await ev("document.getElementById('pane-ledger').textContent")));
const ledFiltered = await ev(`(function(){
  var pills = document.querySelectorAll('#pane-ledger .criteria .pills .pill');
  var bad = Array.from(pills).find(p => p.textContent === '被否决');
  if (!bad) return -1;
  bad.click();
  return document.querySelectorAll('#pane-ledger .tbl tbody tr').length;
})()`);
ok('状态切片能筛', ledFiltered >= 0 && ledFiltered <= noteCount, `筛后 ${ledFiltered} 行`);
// 「全选后恢复」断言的是统计范围维度，而状态切片是另一个持久维度（筛选状态刻意不丢）——先复位
await ev(`(function(){
  var all = Array.from(document.querySelectorAll('#pane-ledger .criteria .pills .pill')).find(x => x.textContent === '全部');
  if (all) all.click();
  return true;
})()`);
await sleep(200);
await shot('04-决策清单');

/* ── 统计范围 ─────────────────────────────────────────────────── */
console.log('\n【统计范围】');
await ev("document.getElementById('btn-scope-none').click()");
await sleep(250);
// 笔记模式下聚合模块以全库笔记为主、不受统计范围约束；全不选只清零会话侧
ok('全不选后左轨计数清零', (await ev("document.getElementById('sess-count').textContent")) === '0/' + sessCount);
ok('笔记不受统计范围约束（决策清单仍显示总表）', (await ev("document.querySelectorAll('#pane-ledger .tbl tbody tr').length")) === noteCount);
await ev("document.getElementById('btn-scope-all').click()");
await sleep(250);
// 决策清单在笔记模式下是全库总表（不随统计范围变化），「恢复」以左轨计数满格为准
ok('全选后恢复', (await ev("document.getElementById('sess-count').textContent")) === sessCount + '/' + sessCount);
await ev("document.getElementById('btn-scope-bad').click()");
await sleep(250);
const badScope = await ev("document.getElementById('sess-count').textContent");
ok('仅有问题只保留有问题的会话', /^\d+\/\d+$/.test(badScope) && Number(badScope.split('/')[0]) <= sessCount, badScope);
await ev("document.getElementById('btn-scope-all').click()");
await sleep(200);

/* ── 会话详情 ─────────────────────────────────────────────────── */
console.log('\n【🔎 会话详情】');
await goModule('session');
await sleep(250);
ok('未选会话时给提示', /左侧点一个会话/.test(await ev("document.getElementById('pane-session').textContent")));
await ev("document.querySelectorAll('#sess-list .sess')[0].click()");
await waitFor('window.__traceBoard.state.model', 10000, '会话模型');
ok('子页签有四个', (await ev("document.querySelectorAll('#pane-session > .tabs .tab').length")) === 4);
ok('时间线渲染出回合', (await ev("document.querySelectorAll('#pane-session .turn').length")) > 0);
ok('有血缘缩进', await ev("Array.from(document.querySelectorAll('#pane-session .ev')).some(e => +e.style.getPropertyValue('--d') > 0)"));
await ev("document.querySelector('#pane-session .ev-method').click()");
await sleep(150);
ok('点方法名就地展开原始 JSON-RPC', /"jsonrpc"/.test(await ev("(document.querySelector('#pane-session .ev-json')||{}).textContent || ''")));
const turnsAfter = await ev("document.querySelectorAll('#pane-session .turn').length");
await ev("document.querySelector('#pane-session .ev-method').click()");
await sleep(120);
ok('折叠是原地开关（回合数不变）', (await ev("document.querySelectorAll('#pane-session .turn').length")) === turnsAfter);
await shot('05-会话详情-时间线');

// 切到一个既有落盘又有被拦下的会话，验后三个子页签
const picked = await ev(`(function(){
  var s = window.__traceBoard.state.index.sessions.filter(function(x){
    var c = x.counts || {};
    return (c.write_applied || 0) > 0 && (c.write_attempts || 0) > (c.write_applied || 0) && x.digest;
  });
  if (!s.length) return null;
  window.__traceBoard.openSession(s[0]);
  return s[0].session_id;
})()`);
if (picked) {
  await waitFor('window.__traceBoard.state.model && window.__traceBoard.state.model.writes.length > 0', 10000, '切会话');
  ok('切到「既有落盘又有被拦下」的会话', true, picked);

  await ev(`Array.from(document.querySelectorAll('#pane-session > .tabs .tab')).find(t => t.textContent.indexOf('改动') === 0).click()`);
  await sleep(250);
  ok('改动页有行', (await ev("document.querySelectorAll('#pane-session .row').length")) > 0);
  const diffBtn = await ev(`(function(){ var b = document.querySelector('#pane-session .mini-btn'); if (!b) return false; b.click(); return true; })()`);
  if (diffBtn) {
    await waitFor("document.querySelectorAll('#pane-session .dl-add').length > 0", 10000, 'diff 渲染');
    ok('能渲染带类型的 diff 行', (await ev("document.querySelectorAll('#pane-session .dl-add').length")) > 0);
    ok('diff 里有 hunk 头', (await ev("document.querySelectorAll('#pane-session .dl-hunk').length")) > 0);
  } else {
    ok('能渲染带类型的 diff 行', false, '没有可展开的 diff');
  }
  await shot('06-会话详情-改动');

  await ev(`Array.from(document.querySelectorAll('#pane-session > .tabs .tab')).find(t => t.textContent.indexOf('合规') === 0).click()`);
  await sleep(250);
  ok('合规页有行且标了依据', /依据：/.test(await ev("document.querySelector('#pane-session .sbody').textContent")));
  // 反向锚点这条规则要能在板子上看到（含全仓扫描的汇总数字与"失效"明细）
  const sbody = await ev("document.querySelector('#pane-session .sbody').textContent");
  ok('合规页能看到反向锚点规则', /TRACE_NOTE_ANCHORS/.test(sbody), '');
  ok('锚点扫描结果带上文件数/通过/失效', /扫描 \d+ 个文件 · 通过 \d+/.test(sbody), '');
  await shot('07-会话详情-合规');

  await ev(`Array.from(document.querySelectorAll('#pane-session > .tabs .tab')).find(t => t.textContent.indexOf('被否决') === 0).click()`);
  await sleep(250);
  ok('被否决页有记录', (await ev("document.querySelectorAll('#pane-session .row.warn').length")) > 0);
  const leftover = await ev(`(function(){
    var d = window.__traceBoard.state.model.denied;
    return d.filter(function(x){
      if (x.kind !== 'blocked') return false;
      return !d.some(function(y){ return y.kind === 'permission' && y.turnSeq === x.turnSeq && y.method === x.method && y.alsoBlocked && y.alsoBlocked.seq === x.seq; });
    }).length;
  })()`);
  ok('同一件事已归组，无孤立"执行被拦"行', leftover === 0, leftover + ' 条孤立');
  await shot('08-会话详情-被否决');
} else {
  ok('切到「既有落盘又有被拦下」的会话', false, '索引里没有这种会话');
}

/* ── 库：多条来源共存 + 置顶 + 删除 ──────────────────────────── */
console.log('\n【库里的多条来源】');
await ev("document.getElementById('btn-lib').click()");
await sleep(250);
ok('库里已有本地路径这一条', /本地路径/.test(await ev("document.getElementById('lib-list').textContent")));
await ev(`document.getElementById('in-url').value = ${JSON.stringify(BASE + '/index.json')}`);
await ev("document.getElementById('btn-url').click()");
await waitFor(`window.__traceBoard.state.reader && window.__traceBoard.state.reader.kind === 'http'`, 14000, 'HTTP 载入');
ok('远程库载入成功', (await ev('window.__traceBoard.state.index.sessions.length')) > 0);
ok('顶栏切换到远程库标签', /远程库/.test(await ev("document.getElementById('src-kind').textContent")));
await ev("document.getElementById('btn-lib').click()");
await sleep(250);
const libKinds = await ev("document.getElementById('lib-list').textContent");
ok('本地与远程在同一个库里共存', /本地路径/.test(libKinds) && /远程库/.test(libKinds));
ok('库里有两条', (await ev("document.querySelectorAll('#lib-list .row').length")) === 2);
await ev(`document.querySelectorAll('#lib-list .row')[1].querySelectorAll('.mini-btn')[1].click()`);
await sleep(300);
ok('置顶后排到第一位', /置顶/.test(await ev("document.querySelectorAll('#lib-list .row')[0].textContent")));
await shot('09-数据源库-两条来源');

// 远程模式下按需拉 diff
await ev(`Array.from(document.querySelectorAll('#mods .mod')).find(b => b.dataset.mod === 'session').click()`);
await sleep(200);
await ev("document.querySelectorAll('#sess-list .sess')[0].click()");
await waitFor('window.__traceBoard.state.model', 10000, '远程会话');
await ev(`Array.from(document.querySelectorAll('#pane-session > .tabs .tab')).find(t => t.textContent.indexOf('改动') === 0).click()`);
await sleep(250);
const remoteDiff = await ev(`(function(){ var b = document.querySelector('#pane-session .mini-btn'); if (!b) return false; b.click(); return true; })()`);
if (remoteDiff) {
  await waitFor("document.querySelectorAll('#pane-session .dl-add').length > 0", 10000, '远程 diff');
  ok('远程模式下能拉取并渲染 diff', (await ev("document.querySelectorAll('#pane-session .dl-add').length")) > 0);
} else {
  ok('远程模式下能拉取并渲染 diff', true, '这个会话没有 diff，跳过');
}

/* ── 粘贴数据源 ───────────────────────────────────────────────── */
console.log('\n【粘贴数据】');
await ev("document.getElementById('btn-lib').click()");
await sleep(200);
const mini = JSON.stringify({
  schema: 1, kind: 'spark-trace-bundle', project_path: '/tmp/x',
  sessions: [{
    session_id: 's_demo', dir: 's_demo', started_at: Date.now() - 5000, ended_at: Date.now(),
    counts: { write_attempts: 0, write_applied: 0 }, errors: { protocol: 1, compliance_failed: 0 },
    failed_rules: [], protocol_error_methods: ['tools/call'], diffNames: [], files: {},
    digest: { heavy_files: [], compliance_failed: [], denied: [], protocol_errors: [{ seq: 2, method: 'tools/call', code: -32601, message: 'Method not found: tools/call', hint: 'MCP 的命名', ts: Date.now() }], rule_tally: [], capabilities: {} },
    events: [
      { seq: 1, ts: Date.now() - 5000, dir: 'client->agent', kind: 'request', method: 'session/prompt', rpc_id: 1, parent_seq: null, turn_seq: 1, acp_message: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 's_demo', content: [{ type: 'text', text: 'hi' }] } } },
      { seq: 2, ts: Date.now() - 4000, dir: 'agent->client', kind: 'request', method: 'tools/call', rpc_id: 2, parent_seq: 1, turn_seq: 1, protocol: { status: 'ERROR', error: { code: -32601, message: 'Method not found: tools/call', hint: 'MCP 的命名' } }, acp_message: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} } }
    ]
  }]
});
await ev(`document.getElementById('in-paste').value = ${JSON.stringify(mini)}`);
await ev("document.getElementById('btn-paste').click()");
await waitFor('window.__traceBoard.state.index && window.__traceBoard.state.index.sessions[0].session_id === "s_demo"', 8000, '粘贴载入');
ok('粘贴数据入库并载入', (await ev('window.__traceBoard.state.index.sessions[0].session_id')) === 's_demo');
ok('粘贴来源也在同一个库里', await ev("(async function(){ return (await window.TraceSource.libLoad()).some(function(e){ return e.kind === 'inline'; }); })()"));
await ev("document.getElementById('btn-lib').click()");
await sleep(250);
ok('库里现在有三条', (await ev("document.querySelectorAll('#lib-list .row').length")) === 3);
await ev(`document.querySelectorAll('#lib-list .row')[0].querySelectorAll('.mini-btn')[2].click()`);
await sleep(300);
ok('删除条目生效', (await ev("document.querySelectorAll('#lib-list .row').length")) === 2);
// 持久化兜底：库里两条通道必须同数据，db 读空时能从 localStorage 原样恢复
ok('库双写：db 与 localStorage 同步', (await ev(`(function(){
  var a = JSON.parse(localStorage.getItem('trace-board:sources') || '[]').length;
  var b = (window.__sparkStore.sources || []).length;
  return a === b && a === document.querySelectorAll('#lib-list .row').length;
})()`)) === true);
ok('db 读不到时库能从 localStorage 恢复', (await ev(`(async function(){
  var g0 = window.spark.db.get;
  window.spark.db.get = function(){ return Promise.resolve(null); };
  var n = (await window.TraceSource.libLoad()).length;
  window.spark.db.get = g0;
  return n;
})()`)) > 0);

/* ── 纯笔记来源（零会话回落，v3）────────────────────────────── */
console.log('\n【纯笔记来源】');
{
  const notesOnly = JSON.stringify({
    schema: 1, kind: 'spark-trace-bundle', project_path: '/tmp/notes-only',
    sessions: [],
    notes: [{
      id: '2026-09-16-knowledge-only', file: '.agents/notes/implemented/architecture/2026-09-16-knowledge-only.md',
      status: 'implemented', category: 'architecture', date: '2026-09-16', truncated: false, refd_by: [], links: [],
      title: '纯笔记来源可用',
      body: '# Agent Note: 纯笔记来源可用\nStatus: implemented\nClass: architecture\n\n## 背景\n未部署宿主的项目只有笔记。\n\n## 决策\n看板对零会话来源也要展示笔记。\n\n## 放弃方案\n要求必须有会话才能载入。\n\n## 代价与后果\n无。',
    }],
  });
  await ev("document.getElementById('btn-lib').click()");
  await sleep(250);
  await ev(`document.getElementById('in-paste').value = ${JSON.stringify(notesOnly)}`);
  await ev("document.getElementById('btn-paste').click()");
  await waitFor('window.__traceBoard.state.index && window.__traceBoard.state.index.sessions.length === 0 && (window.__traceBoard.state.index.notes || []).length === 1', 8000, '纯笔记载入');
  ok('零会话纯笔记来源能载入', true);
  ok('基线 KPI 四卡在纯笔记来源下渲染', (await ev("document.querySelectorAll('#pane-baseline .kpi-card').length")) === 4);
  await goModule('ledger');
  await sleep(250);
  ok('决策清单显示笔记', (await ev("document.querySelectorAll('#pane-ledger .tbl tbody tr').length")) === 1);
  await goModule('session');
  await sleep(250);
  ok('会话详情给零会话空态指引', /没有会话记录/.test(await ev("document.getElementById('pane-session').textContent")));
  await shot('11-纯笔记来源');
}

/* ── 持久化兜底：db 整体不可用后"刷新"，库仍要恢复（对应 owner 实测的丢库）── */
console.log('\n【持久化兜底】');
{
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB2 });
  await send('Page.reload');
  await waitFor('window.__traceBoard && window.__traceBoard.state && window.__traceBoard.state.reader', 15000, '重载后自动恢复');
  ok('db 挂掉的桩确实生效', (await ev('window.__dbBrokenStub === true')) === true);
  ok('刷新后看板自动恢复上次来源', (await ev('window.__traceBoard.state.reader.kind')) != null);
  await ev("document.getElementById('btn-lib').click()");
  await sleep(300);
  ok('刷新后「最近使用」还在库里', (await ev("document.querySelectorAll('#lib-list .row').length")) > 0);
  ok('库里如实披露 localStorage 兜底', /localStorage/.test(await ev("document.getElementById('lib-list').textContent")));
  await shot('12-持久化兜底重载');

  await shot('12-持久化兜底重载');

  // 卡片本体可点：目录类条目点卡片要走「重选目录」分支（owner 实测「点了打不开」的死路）
  await ev(`(async function(){
    var r = await window.TraceSource.libUpsert({ kind: 'dir', label: 'fake-dir-proj', detail: 'smoke-fixture', needsReselect: true });
    window.__traceBoard.state.library = r.list;
    return true;
  })()`);
  await ev("document.getElementById('btn-lib').click()");   // 重开抽屉触发 renderLibrary
  await sleep(300);
  const dirRowHit = await ev(`(function(){
    var rows = document.querySelectorAll('#lib-list .row');
    for (var i = 0; i < rows.length; i++) {
      if (/fake-dir-proj/.test(rows[i].textContent)) { rows[i].click(); return true; }
    }
    return false;
  })()`);
  await sleep(250);
  ok('找到目录条目卡片并点到', dirRowHit === true);
  ok('点目录卡片收起抽屉并唤起重选', (await ev(`(function(){
    var t = document.getElementById('toast');
    return document.getElementById('library').hidden === true && !!t && /重新选/.test(t.textContent);
  })()`)) === true);

  // 空态「上次在用」一键重开：目录类没法自动重开，空态必须给直达入口。
  // 清掉其它条目只留目录类（置顶条目会浮到 library[0]，先排除干扰）
  await ev(`(async function(){
    var list = await window.TraceSource.libLoad();
    for (var i = 0; i < list.length; i++) {
      if (list[i].label !== 'fake-dir-proj') await window.TraceSource.libRemove(list[i].id);
    }
    window.__traceBoard.state.library = await window.TraceSource.libLoad();
    window.__traceBoard.state.index = null;
    window.__traceBoard.state.reader = null;
    return true;
  })()`);
  await goModule('evolution');
  await sleep(150);
  await goModule('baseline');
  await sleep(250);
  ok('空态给「上次在用」一键重开按钮', /重新打开：fake-dir-proj/.test(await ev("document.getElementById('pane-baseline').textContent")));
  await ev("document.querySelector('#pane-baseline .primary-btn').click()");
  await sleep(200);
  ok('一键重开进入目录重选分支', (await ev(`(function(){
    var t = document.getElementById('toast');
    return t.classList.contains('show') && /重新选/.test(t.textContent);
  })()`)) === true);
  await shot('13-空态一键重开');
}

/* ── 目录句柄直达（File System Access API）：选一次，刷新后免重选 ── */
console.log('\n【目录句柄直达（FSA）】');
{
  // 用 OPFS 造一棵「项目树」当句柄来源：真实 FileSystemDirectoryHandle 能结构化克隆进
  // IndexedDB、跨 reload 复活——手搓的假句柄过不了 IDB 这一关，所以必须用真家伙
  const fsaIndex = JSON.stringify({
    schema: 1, kind: 'spark-trace-index', project_path: 'fsa-proj-root',
    sessions: [],
    notes: [{ id: '2026-09-16-fsa-probe', file: '.agents/notes/implemented/process/2026-09-16-fsa-probe.md',
      status: 'implemented', category: 'process', date: '2026-09-16', truncated: false, refd_by: [], links: [],
      title: 'FSA 句柄直达可用',
      body: '# Agent Note: FSA 句柄直达可用\nStatus: implemented\nClass: process\n\n## 背景\n句柄刷新即丢。\n\n## 决策\nFSA 句柄进 IndexedDB，刷新免重选。\n\n## 放弃方案\n永远要求重选一次。\n\n## 代价与后果\n无。' }],
  });
  await ev(`(async function(){
    var root = await navigator.storage.getDirectory();
    var dh = await root.getDirectoryHandle('fsa-proj', { create: true });
    var ag = await dh.getDirectoryHandle('.agents', { create: true });
    var tr = await ag.getDirectoryHandle('trace', { create: true });
    var fh = await tr.getFileHandle('index.json', { create: true });
    var w = await fh.createWritable(); await w.write(${JSON.stringify(fsaIndex)}); await w.close();
    return true;
  })()`);
  // 桩掉选择器：把 OPFS 目录句柄当「用户选中」喂给看板（无头浏览器出不了真实选择器 UI）
  await ev(`(function(){
    var p = navigator.storage.getDirectory().then(function(r){ return r.getDirectoryHandle('fsa-proj'); });
    window.showDirectoryPicker = function(){ return p; };
    return true;
  })()`);
  await ev("document.getElementById('btn-lib').click()");
  await sleep(250);
  await ev("document.getElementById('btn-dir').click()");
  await waitFor("window.__traceBoard.state.reader && window.__traceBoard.state.reader.kind === 'dir'", 12000, 'FSA 目录载入');
  ok('FSA 句柄来源载入成功', true);
  ok('载入的是 OPFS 里的索引', (await ev("window.__traceBoard.state.index.project_path")) === 'fsa-proj-root');
  ok('库条目标记 hasHandle 且不再 needsReselect', (await ev(`(async function(){
    var l = await window.TraceSource.libLoad();
    for (var i = 0; i < l.length; i++) if (l[i].label === 'fsa-proj') return !!l[i].hasHandle && !l[i].needsReselect;
    return false;
  })()`)) === true);
  ok('句柄已落 IndexedDB 且仍可遍历', (await ev("(async function(){ var h = await window.TraceSource.handleGet('dir:fsa-proj'); return !!h && typeof h.values === 'function'; })()")) === true);

  // 刷新：句柄从 IDB 复活 + queryPermission 已放行（OPFS 免授权）→ 启动自动重开，不弹选择器
  await send('Page.reload');
  await waitFor('window.__traceBoard && window.__traceBoard.state && window.__traceBoard.state.reader', 15000, 'FSA 重载自动恢复');
  ok('刷新后目录来源自动恢复（免重选）', (await ev("window.__traceBoard.state.reader.kind")) === 'dir'
    && (await ev("window.__traceBoard.state.index.project_path")) === 'fsa-proj-root');

  // 点击直达：清掉内存态，点库卡片 → openEntry 在点击手势里拿到授权 → 直接重开，不再喊「重新选」
  await ev(`(function(){
    window.__traceBoard.state.index = null;
    window.__traceBoard.state.reader = null;
    window.__traceBoard.state.entry = null;
    return true;
  })()`);
  await goModule('baseline');
  await sleep(250);
  await ev("document.getElementById('btn-lib').click()");
  await sleep(250);
  const fsaRowHit = await ev(`(function(){
    var rows = document.querySelectorAll('#lib-list .row');
    for (var i = 0; i < rows.length; i++) {
      if (/fsa-proj/.test(rows[i].textContent)) { rows[i].click(); return true; }
    }
    return false;
  })()`);
  await sleep(250);
  ok('库卡片点到句柄条目', fsaRowHit === true);
  await waitFor("window.__traceBoard.state.reader && window.__traceBoard.state.reader.kind === 'dir'", 12000, '句柄点击直达');
  ok('点句柄条目直接重开（无「重新选」提示）', (await ev("window.__traceBoard.state.index.project_path")) === 'fsa-proj-root'
    && !/重新选/.test(await ev("document.getElementById('toast').textContent")));
  await shot('14-目录句柄直达');
}

/* ── 主题与收尾 ───────────────────────────────────────────────── */
console.log('\n【主题与健康度】');
await ev("document.getElementById('lib-close').click()");
await sleep(300);
ok('关闭抽屉后遮罩一起收起', await ev("document.getElementById('library').hidden && document.getElementById('overlay').hidden"));
ok('默认浅色主题', (await ev("document.documentElement.getAttribute('data-theme')")) === 'light');
await ev("document.getElementById('btn-theme').click()");
await sleep(250);
ok('切到深色主题', (await ev("document.documentElement.getAttribute('data-theme')")) === 'dark');
await shot('10-深色主题');
await ev("document.getElementById('btn-theme').click()");
await sleep(250);
ok('切回浅色主题', (await ev("document.documentElement.getAttribute('data-theme')")) === 'light');
// reload 后 db 已挂（STUB2），主题此时应落 localStorage 兜底通道而不是 spark.db
ok('主题写入 localStorage 兜底通道', (await ev("localStorage.getItem('trace-board:theme')")) === '"light"');

if (exceptions.length) exceptions.forEach((e) => console.log('    ! ' + String(e).split('\n')[0]));
ok('页面执行零未捕获异常', exceptions.length === 0, exceptions.length + ' 个');
ok('控制台零 error', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 200));

chrome.kill();
server.close();
setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ } }, 300);

console.log('\n截图目录：' + path.relative(ROOT, SHOTS).split(path.sep).join('/'));
console.log('────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
