/* 密码管家 · 图标几何自检（Node + 无头 Chrome）
 *
 * 运行：node password-manager/tests/icon-test.mjs
 *
 * 为什么要有这个：图标「看着没居中」是能算出来的——把 SVG 光栅化成像素，
 * 量白色图形的包围盒与四边留白。第一版图标就是纵向偏高 4.6/64（上方留白 30、下方 66，差 2.2 倍），
 * 肉眼看只是「有点怪」，量出来一目了然。断言写死后就不容易再退化。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(here, '..', '0.1.0', 'icon.svg');
const svg = fs.readFileSync(ICON, 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

/* ---------- 静态检查 ---------- */
console.log('\n密码管家 · 图标几何自检\n');
const viewBox = (svg.match(/viewBox="([^"]+)"/) || [])[1];
ok('viewBox 为 0 0 64 64', viewBox === '0 0 64 64', String(viewBox));
ok('无脚本/外链（纯静态 SVG）', !/<script|href="http|xlink:href="http/i.test(svg));

/* ---------- 光栅化量测 ---------- */
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('未找到 Chrome/Edge，跳过像素量测'); process.exit(fail ? 1 : 0); }

const N = 256;                 /* 光栅化尺寸 */
const SCALE = 64 / N;          /* 像素 → 64 视图单位 */
const PORT = 9993 + Math.floor(Math.random() * 90);
const profile = path.join(os.tmpdir(), 'icon-test-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let list;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); list = await r.json(); if (list.some((t) => t.type === 'page')) break; } catch (e) { /* 等待启动 */ }
  await sleep(200);
}
if (!list || !list.length) { console.log('浏览器启动失败'); chrome.kill(); process.exit(1); }
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: 'data:text/html,<body></body>' });
await sleep(500);
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

const raw = await ev(`(function(){
  return new Promise(function(resolve){
    var img = new Image();
    img.onload = function(){
      var cv = document.createElement('canvas'); cv.width = ${N}; cv.height = ${N};
      var ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, ${N}, ${N});
      var d = ctx.getImageData(0, 0, ${N}, ${N}).data;
      function box(pred){
        var minX=1e9,minY=1e9,maxX=-1,maxY=-1,n=0;
        for (var y=0;y<${N};y++) for (var x=0;x<${N};x++){
          var i=(y*${N}+x)*4;
          if (d[i+3] < 24) continue;                 /* 透明区不算 */
          if (pred && !pred(d[i],d[i+1],d[i+2])) continue;
          n++;
          if (x<minX)minX=x; if (x>maxX)maxX=x; if (y<minY)minY=y; if (y>maxY)maxY=y;
        }
        return { minX:minX, maxX:maxX, minY:minY, maxY:maxY, n:n };
      }
      resolve(JSON.stringify({
        tile:  box(null),                                                  /* 圆角底板 */
        glyph: box(function(r,g,b){ return r>230 && g>230 && b>230; })     /* 白色盾牌+锁孔 */
      }));
    };
    img.onerror = function(){ resolve(JSON.stringify({ error: 'SVG 加载失败' })); };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(${JSON.stringify(svg)})));
  });
})()`);
chrome.kill();
setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }, 300);

const m = JSON.parse(raw);
if (m.error) { console.log('  ✗ ' + m.error); process.exit(1); }

const u = (v) => +(v * SCALE).toFixed(2);                       /* 像素 → 64 单位 */
const glyph = {
  x0: u(m.glyph.minX), x1: u(m.glyph.maxX) + SCALE,
  y0: u(m.glyph.minY), y1: u(m.glyph.maxY) + SCALE,
};
glyph.cx = +((glyph.x0 + glyph.x1) / 2).toFixed(2);
glyph.cy = +((glyph.y0 + glyph.y1) / 2).toFixed(2);
const tile = { x0: u(m.tile.minX), x1: u(m.tile.maxX) + SCALE, y0: u(m.tile.minY), y1: u(m.tile.maxY) + SCALE };
tile.cx = +((tile.x0 + tile.x1) / 2).toFixed(2);
tile.cy = +((tile.y0 + tile.y1) / 2).toFixed(2);
const padL = +(glyph.x0 - tile.x0).toFixed(2), padR = +(tile.x1 - glyph.x1).toFixed(2);
const padT = +(glyph.y0 - tile.y0).toFixed(2), padB = +(tile.y1 - glyph.y1).toFixed(2);

console.log(`  量测（64 视图单位）：底板 x[${tile.x0},${tile.x1}] y[${tile.y0},${tile.y1}]，` +
  `图形 x[${glyph.x0},${glyph.x1}] y[${glyph.y0},${glyph.y1}]`);
console.log(`  留白：左 ${padL} 右 ${padR} 上 ${padT} 下 ${padB}\n`);

ok('底板 60×60 且居中于 64×64', Math.abs(tile.cx - 32) <= 0.3 && Math.abs(tile.cy - 32) <= 0.3,
  `中心 (${tile.cx}, ${tile.cy})`);
ok('盾牌+锁孔水平居中（偏差 ≤ 0.8 单位）', Math.abs(glyph.cx - 32) <= 0.8, `中心 x=${glyph.cx}`);
ok('盾牌+锁孔垂直居中（偏差 ≤ 0.8 单位）', Math.abs(glyph.cy - 32) <= 0.8, `中心 y=${glyph.cy}`);
ok('左右留白对称（差 ≤ 0.6）', Math.abs(padL - padR) <= 0.6, `左 ${padL} / 右 ${padR}`);
ok('上下留白对称（差 ≤ 0.9）', Math.abs(padT - padB) <= 0.9, `上 ${padT} / 下 ${padB}`);
ok('图形未过大（四周至少留 4 单位边距）', Math.min(padL, padR, padT, padB) >= 4,
  `最小边距 ${Math.min(padL, padR, padT, padB)}`);
ok('图形未过小（至少占底板宽度的 60%）', (glyph.x1 - glyph.x0) / (tile.x1 - tile.x0) >= 0.6,
  `${(100 * (glyph.x1 - glyph.x0) / (tile.x1 - tile.x0)).toFixed(1)}%`);

console.log('\n────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
