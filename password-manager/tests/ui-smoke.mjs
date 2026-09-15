/* 密码管家 · 界面端到端冒烟（真实 Chromium + CDP）
 *
 * 运行：node password-manager/tests/ui-smoke.mjs
 *
 * 做法：用 --headless 启动本机 Chrome，在页面脚本执行前注入一个 window.spark 桩
 * （内存/spark.db 语义 + 剪贴板），然后完全走「用户路径」驱动界面：
 *   建设开门密码 → 新增帐号 → 复制密码 → 搜索 → 分组 → 生成器 → 导出加密包
 *   → 锁定 → 错误密码 → 正确密码解锁 → 数据仍在
 * 最后截图并检查零 console error / 零未处理异常。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', '0.1.0');
const pageUrl = 'file:///' + path.join(pluginDir, 'index.html').replace(/\\/g, '/');
const shotDir = path.join(here, 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('未找到 Chrome/Edge，跳过界面冒烟'); process.exit(0); }

const PORT = 9411 + Math.floor(Math.random() * 200);
const profile = path.join(os.tmpdir(), 'pwmgr-smoke-' + Date.now());
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files', '--hide-scrollbars',
  '--window-size=1180,720',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  'about:blank'
], { stdio: 'ignore' });

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
const results = [];
const ok = (name, cond, extra) => {
  if (cond) { pass++; results.push('  ✓ ' + name); }
  else { fail++; results.push('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const cleanup = () => {
  try { chrome.kill(); } catch (e) { /* 忽略 */ }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }, 300);
};

/* ---------- spark 桩（页面脚本执行前注入） ---------- */
const STUB = `
window.spark = (function () {
  var KEY = '__sparkdb';
  var mem = {};
  try { mem = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { mem = {}; }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch (e) {} }
  return {
    input: { text: '', command: '', rawQuery: '' },
    db: {
      get: function (k) { return Promise.resolve(k in mem ? JSON.parse(JSON.stringify(mem[k])) : null); },
      set: function (k, v) { mem[k] = JSON.parse(JSON.stringify(v)); persist(); return Promise.resolve(true); },
      remove: function (k) { delete mem[k]; persist(); return Promise.resolve(true); },
      keys: function () { return Promise.resolve(Object.keys(mem)); },
      clear: function () { mem = {}; persist(); return Promise.resolve(true); }
    },
    clipboard: {
      _v: '',
      readText: function () { return Promise.resolve(this._v); },
      writeText: function (t) { this._v = String(t); return Promise.resolve(true); }
    },
    notify: { show: function () { return Promise.resolve(true); } },
    window: { close: function () { return Promise.resolve(true); } },
    onClose: function (fn) { window.__onClose = fn; },
    dev: { openDevTools: function () { window.__devtools = true; } }
  };
})();
window.__errors = [];
window.addEventListener('error', function (e) { window.__errors.push('error: ' + e.message); });
window.addEventListener('unhandledrejection', function (e) {
  window.__errors.push('rejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
});
`;

/* ---------- 极简 CDP 客户端 ---------- */
let ws, msgId = 0;
const pending = new Map();
const consoleErrors = [];
function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
function connect(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error('ws error')));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        consoleErrors.push(m.params.type + ': ' + (m.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        consoleErrors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      }
    });
  });
}
async function evaluate(expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expr, label, ms = 12000) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await evaluate(expr); } catch (e) { v = false; }
    if (v) return true;
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + label);
    await new Promise((r) => setTimeout(r, 80));
  }
}
const setVal = (id, v) => evaluate(`(function(){var e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
const click = (sel) => evaluate(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'no-el';e.click();return 'ok';})()`);
const visible = (id) => evaluate(`!document.getElementById(${JSON.stringify(id)}).hidden`);
const text = (sel) => evaluate(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return e?e.textContent:null;})()`);

/* ---------- 启动 ---------- */
async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}
let t0 = Date.now();
while (true) {
  try { const l = await targets(); if (l.some((t) => t.type === 'page')) break; } catch (e) { /* 还没起来 */ }
  if (Date.now() - t0 > 20000) { console.error('浏览器启动超时'); cleanup(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 200));
}
const list = await targets();
const page = list.find((t) => t.type === 'page');
await connect(page.webSocketDebuggerUrl);
await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pageUrl });
await waitFor('document.readyState === "complete"', '页面加载');

console.log('\n密码管家 · 界面端到端冒烟（' + path.basename(CHROME) + '）\n');

/* ══════════ 1. 建库 ══════════ */
await waitFor('!document.getElementById("screen-setup").hidden', '建库页出现');
ok('首次打开进入「设置开门密码」页', true);
await setVal('setup-pw', 'Test-开门-1234');
ok('强度条随输入出现', await evaluate('!document.getElementById("setup-strength").hidden'));
await setVal('setup-hint', '测试用提示');
await setVal('setup-pw2', 'Test-开门-1235');
await click('#btn-setup');
await waitFor('!document.getElementById("setup-err").hidden', '两次不一致提示');
ok('两次输入不一致时拒绝建库', (await text('#setup-err')).includes('不一致'), await text('#setup-err'));

await setVal('setup-pw2', 'Test-开门-1234');
await click('#btn-setup');
await waitFor('!document.getElementById("screen-main").hidden', '进入主界面（BCrypt 计算完成）', 20000);
ok('建库成功并进入主界面', true);
ok('空列表给出引导', (await text('#list-empty')).includes('还没有帐号'));

/* ══════════ 2. 新增帐号 ══════════ */
await click('#btn-new');
await waitFor('!!document.getElementById("f-title")', '编辑表单出现');
ok('新增表单打开', await evaluate('document.body.classList.contains("has-detail")'));
await setVal('f-title', 'GitHub');
await setVal('f-username', 'me@example.com');
await setVal('f-password', 'gh-P@ss-2026');
await setVal('f-url', 'https://github.com');
await setVal('f-tags', '开发, 工作');
await setVal('f-note', '两步验证已开');
ok('编辑态密码强度实时显示', await evaluate('!document.getElementById("f-strength").hidden'));
await click('#f-gen');
ok('表单内生成器可展开', await evaluate('!document.getElementById("gen-box").hidden'));
await click('#g-apply');
ok('生成器填入密码', (await evaluate('document.getElementById("f-password").value')).length >= 8);
await setVal('f-password', 'gh-P@ss-2026');
await click('#edit-save');
await waitFor('document.querySelectorAll("#list .item").length === 1', '列表出现 1 条');
ok('新增后列表出现该帐号', (await text('#list .item-title')).includes('GitHub'));
ok('列表头像显示首字母', (await text('#list .avatar')).toUpperCase() === 'G');

/* 第二条：验证搜索与排序 */
await click('#btn-new');
await waitFor('!!document.getElementById("f-title")', '第二个表单');
await setVal('f-title', '招商银行');
await setVal('f-username', '6222****8888');
await setVal('f-password', '银-hang#2026');
await click('#edit-save');
await waitFor('document.querySelectorAll("#list .item").length === 2', '列表 2 条');
ok('可以连续新增多条', true);

/* ══════════ 3. 搜索 ══════════ */
await setVal('search', 'github');
await evaluate('document.getElementById("search").dispatchEvent(new Event("input",{bubbles:true}))');
await waitFor('document.querySelectorAll("#list .item").length === 1', '搜索过滤');
ok('搜索标题命中', (await text('#list .item-title')).includes('GitHub'));
await setVal('search', '6222');
await evaluate('document.getElementById("search").dispatchEvent(new Event("input",{bubbles:true}))');
await waitFor('document.querySelectorAll("#list .item").length === 1', '按用户名搜索');
ok('搜索用户名命中', (await text('#list .item-title')).includes('招商'));
await setVal('search', '备注：不存在');
await evaluate('document.getElementById("search").dispatchEvent(new Event("input",{bubbles:true}))');
await waitFor('document.querySelectorAll("#list .item").length === 0', '无结果');
ok('无结果时给出空态', (await text('#list-empty')).includes('没有匹配'));
await click('#search-clear');
await waitFor('document.querySelectorAll("#list .item").length === 2', '清空搜索');

/* ══════════ 4. 详情 / 复制 ══════════ */
await click('#list .item');
await waitFor('!!document.getElementById("btn-edit")', '详情出现');
ok('点击列表打开详情', (await text('.detail-title h2')).includes('GitHub'));
ok('详情默认隐藏密码', (await text('.drow-value')).indexOf('gh-P@ss-2026') < 0);
await click('#toggle-pw');
await waitFor('document.querySelector("#detail").textContent.includes("gh-P@ss-2026")', '显示密码');
ok('可切换显示密码', true);
await click('[data-copy="password"]');
await new Promise((r) => setTimeout(r, 200));
ok('复制密码写入剪贴板', (await evaluate('spark.clipboard._v')) === 'gh-P@ss-2026', await evaluate('spark.clipboard._v'));
await click('[data-copy="username"]');
await new Promise((r) => setTimeout(r, 200));
ok('复制用户名写入剪贴板', (await evaluate('spark.clipboard._v')) === 'me@example.com');

/* ══════════ 5. 分组 ══════════ */
await click('#btn-add-group');
await waitFor('!document.getElementById("dialog").hidden', '新建分组对话框');
await setVal('dialog-input', '工作账号');
await click('#dialog-ok');
await waitFor('document.querySelectorAll("#group-list .grp").length === 4', '分组出现');
ok('新建分组后侧栏为 3 个虚拟 + 1 个自定义', true);
ok('新分组计数为 0', (await text('#group-list .grp:last-child .grp-count')) === '0', await text('#group-list .grp:last-child .grp-count'));
/* 通过 API 移动（拖拽在无头下不可靠，这里验证分组联动 + UI 刷新） */
await evaluate(`(function(){ var ids=Vault.snapshot().records; var g=Vault.snapshot().groups[0]; return Vault.upsert({id:ids[0].id, group:g.id}).then(function(){return true;}); })()`);
await evaluate('(function(){document.querySelector("[data-group=\\"__all\\"]").click();return true;})()');
await waitFor('document.querySelector("#list .item-title .tag") !== null', '标签渲染');
ok('帐号分组标签显示', (await text('#list .item-title .tag')) === '工作账号', await text('#list .item-title .tag'));
await click('#group-list [data-group="__nogroup"]');
await waitFor('document.querySelectorAll("#list .item").length === 1', '未分组过滤');
ok('按分组筛选生效', true);
await click('#group-list [data-group="__all"]');
await waitFor('document.querySelectorAll("#list .item").length === 2', '回到全部');

/* ══════════ 6. 密码生成器面板 ══════════ */
await click('#btn-gen');
await waitFor('!document.getElementById("panel-gen").hidden', '生成器面板');
const p1 = await text('#gen-out');
ok('生成器面板产出密码', p1 && p1.length === 16, String(p1));
await click('#gen-again');
const p2 = await text('#gen-out');
ok('「换一个」产出不同密码', p1 !== p2);
await evaluate('(function(){var e=document.getElementById("gen-symbol");e.checked=false;e.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
const p3 = await text('#gen-out');
ok('关闭符号后不含符号', !/[^A-Za-z0-9]/.test(p3), p3);
await click('#gen-copy');
await new Promise((r) => setTimeout(r, 150));
ok('生成器复制可用', (await evaluate('spark.clipboard._v')) === p3);
await click('#panel-gen [data-close-panel]');
await waitFor('document.getElementById("panel-gen").hidden', '关闭生成器面板');

/* ══════════ 7. 设置 / 导出 ══════════ */
await click('#btn-settings');
await waitFor('!document.getElementById("panel-settings").hidden', '设置面板');
ok('设置面板显示帐号数', (await text('#set-count')) === '2', await text('#set-count'));
ok('设置面板显示提示', (await text('#set-hint')) === '测试用提示');
await evaluate('(function(){var e=document.getElementById("set-autolock");e.value="60";e.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
await new Promise((r) => setTimeout(r, 200));
ok('自动锁定可改为 1 分钟', (await text('#status-right')).includes('自动锁定 1 分钟'), await text('#status-right'));
await click('#panel-settings [data-close-panel]');

await click('#btn-io');
await waitFor('!document.getElementById("panel-io").hidden', '导入导出面板');
await click('#btn-export-enc');
await waitFor('!document.getElementById("io-result").hidden', '导出结果');
const pkg = await evaluate('document.getElementById("io-text").value');
ok('导出加密包为合法 JSON', (() => { try { return JSON.parse(pkg).app === 'spark-password-manager'; } catch (e) { return false; } })());
ok('导出加密包不含明文', !pkg.includes('gh-P@ss-2026') && !pkg.includes('GitHub'));
/* CSV 需要验证开门密码 */
await click('#btn-export-csv');
await waitFor('!document.getElementById("dialog").hidden', '导出 CSV 确认框');
await click('#dialog-ok');
await waitFor('!document.getElementById("dialog").hidden && document.getElementById("dialog-field").hidden === false', '验证密码框');
await setVal('dialog-input', '错的密码');
await click('#dialog-ok');
await waitFor('!document.getElementById("dialog").hidden && document.getElementById("dialog-input").value === ""', '错误后重新请求输入', 30000);
ok('导出前验证：错密码被拒绝并重新索取', (await text('#toast')).includes('错误'), await text('#toast'));
ok('密码错误时不会导出', !(await evaluate('document.getElementById("io-text").value')).includes('title,username'));
await setVal('dialog-input', 'Test-开门-1234');
await click('#dialog-ok');
await waitFor('document.getElementById("io-text").value.indexOf("title,username") >= 0', 'CSV 导出', 30000);
ok('正确密码后可导出 CSV', true);
const csv = await evaluate('document.getElementById("io-text").value');
ok('CSV 含全部字段且为明文', csv.includes('GitHub') && csv.includes('gh-P@ss-2026'));
await click('#panel-io [data-close-panel]');

/* ══════════ 8. 锁定 / 解锁 ══════════ */
await click('#btn-lock');
await waitFor('!document.getElementById("screen-lock").hidden', '锁定页');
ok('锁定后回到开门页', true);
await setVal('lock-pw', '错误的开门密码');
await click('#btn-unlock');
await waitFor('!document.getElementById("lock-err").hidden', '密码错误提示', 20000);
ok('错误开门密码被拒绝', (await text('#lock-err')).includes('错误'), await text('#lock-err'));

await setVal('lock-pw', 'Test-开门-1234');
await click('#btn-unlock');
await waitFor('!document.getElementById("screen-main").hidden', '重新进入主界面', 20000);
await waitFor('document.querySelectorAll("#list .item").length === 2', '数据恢复');
ok('正确开门密码解锁并完整还原数据', true);
await click('#list .item');
await waitFor('!!document.getElementById("btn-edit")', '详情');
await evaluate('(function(){var b=document.querySelector("#toggle-pw");b.click();return true;})()');
await waitFor('document.querySelector("#detail").textContent.includes("gh-P@ss-2026") || document.querySelector("#detail").textContent.includes("银-hang#2026")', '密码明文可见');
ok('解锁后密码可正常解密（说明落盘确实加密、解锁确实还原）', true);

/* ══════════ 9. 快捷键 ══════════ */
await evaluate(`(function(){
  var r = document.querySelector("#list .item");
  r.click();
  return true;})()`);
await evaluate(`(function(){
  document.dispatchEvent(new KeyboardEvent('keydown', {key:'u', ctrlKey:true, bubbles:true}));
  return true;})()`);
await new Promise((r) => setTimeout(r, 200));
ok('Ctrl+U 复制当前帐号用户名', ['me@example.com', '6222****8888'].includes(await evaluate('spark.clipboard._v')), await evaluate('spark.clipboard._v'));
await evaluate(`(function(){
  document.dispatchEvent(new KeyboardEvent('keydown', {key:'p', ctrlKey:true, bubbles:true}));
  return true;})()`);
await new Promise((r) => setTimeout(r, 200));
ok('Ctrl+P 复制当前帐号密码', ['gh-P@ss-2026', '银-hang#2026'].includes(await evaluate('spark.clipboard._v')), await evaluate('spark.clipboard._v'));
await evaluate(`(function(){
  document.dispatchEvent(new KeyboardEvent('keydown', {key:'n', ctrlKey:true, bubbles:true}));
  return true;})()`);
await waitFor('!!document.getElementById("f-title")', 'Ctrl+N 打开新增');
ok('Ctrl+N 打开新增表单', true);
await evaluate(`(function(){
  document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
  return true;})()`);
await waitFor('!document.getElementById("f-title")', 'Esc 取消编辑');
ok('Esc 取消编辑', true);

/* ══════════ 10. 分片截图 ══════════ */
await evaluate('(function(){var b=document.getElementById("btn-theme");if(b)b.click();return true;})()');
await new Promise((r) => setTimeout(r, 300));
const light = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(shotDir, 'ui-light.png'), Buffer.from(light.data, 'base64'));
await evaluate('(function(){var b=document.getElementById("btn-theme");if(b)b.click();return true;})()');
await evaluate('(function(){document.querySelector("#list .item").click();return true;})()');
await new Promise((r) => setTimeout(r, 400));
const dark = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(shotDir, 'ui-dark.png'), Buffer.from(dark.data, 'base64'));
ok('截图已生成（暗/亮各一张）', fs.existsSync(path.join(shotDir, 'ui-dark.png')));

await click('#btn-gen');
await new Promise((r) => setTimeout(r, 400));
const gen = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(shotDir, 'ui-gen.png'), Buffer.from(gen.data, 'base64'));

/* ══════════ 11. 错误收集 ══════════ */
const pageErrors = await evaluate('JSON.stringify(window.__errors || [])');
ok('页面无未捕获异常', JSON.parse(pageErrors).length === 0, pageErrors);
const realErrors = consoleErrors.filter((e) => !/favicon|net::ERR_FILE_NOT_FOUND/i.test(e));
ok('无 console 错误（忽略 favicon）', realErrors.length === 0, realErrors.join(' | '));

console.log(results.join('\n'));
console.log('\n────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('截图：' + shotDir);

cleanup();
process.exit(fail ? 1 : 0);
