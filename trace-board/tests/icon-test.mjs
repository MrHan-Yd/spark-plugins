/* 追溯看板 · 图标几何自检
 *
 * 运行：node trace-board/tests/icon-test.mjs
 *
 * 「看着没居中」是能算出来的：把 SVG 光栅化成像素，量图形的包围盒与四边留白。
 * 本插件的图形由绿/白/琥珀三色构成，底板是深色渐变，所以用"亮度 > 110"区分图形与底板
 * （底板最亮 (42,49,64) 亮度 52，图形最暗 #35d3a1 亮度 142 —— 与 app 内 accent 令牌同源）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(here, '..', '0.1.0', 'icon.svg');
const svg = fs.readFileSync(ICON, 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('\n追溯看板 · 图标几何自检\n');

const viewBox = (svg.match(/viewBox="([^"]+)"/) || [])[1];
ok('viewBox 为 0 0 64 64', viewBox === '0 0 64 64', String(viewBox));
ok('无脚本/外链（纯静态 SVG）', !/<script|href="http|xlink:href="http/i.test(svg));
ok('底板为 2,2 60×60 rx=14', /<rect x="2" y="2" width="60" height="60" rx="14"/.test(svg));

/* ---------- 光栅化量测 ---------- */
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.log('未找到 Chrome/Edge，跳过像素量测');
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项（未做像素量测）`);
  process.exit(fail ? 1 : 0);
}

const N = 256;
const SCALE = 64 / N;
const PORT = 9700 + Math.floor(Math.random() * 90);
const profile = path.join(os.tmpdir(), 'tb-icon-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let list;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    list = await r.json();
    if (list.some((t) => t.type === 'page')) break;
  } catch { /* 等启动 */ }
  await sleep(200);
}
if (!list || !list.length) { console.log('浏览器启动失败'); chrome.kill(); process.exit(1); }

const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
});
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: 'data:text/html,<body></body>' });
await sleep(400);

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
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
          if (d[i+3] < 128) continue;                /* 半透明描边/抗锯齿不算：底板有 0.10 白的描边，叠在透明上是 (255,255,255,alpha≈25)，用 24 当阈值会把它当成图形 */
          if (pred && !pred(d[i],d[i+1],d[i+2])) continue;
          n++;
          if (x<minX)minX=x; if (x>maxX)maxX=x; if (y<minY)minY=y; if (y>maxY)maxY=y;
        }
        return { minX:minX, maxX:maxX, minY:minY, maxY:maxY, n:n };
      }
      var bright = function(r,g,b){ return (r+g+b)/3 > 110; };
      resolve(JSON.stringify({
        tile:  box(null),
        glyph: box(bright),
        green: box(function(r,g,b){ return g>190 && r<190 && b<190; }),
        white: box(function(r,g,b){ return r>210 && g>210 && b>210; }),
        amber: box(function(r,g,b){ return r>200 && g>=140 && g<=210 && b<140; })
      }));
    };
    img.onerror = function(){ resolve(JSON.stringify({ error: 'SVG 加载失败' })); };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(${JSON.stringify(svg)})));
  });
})()`);

chrome.kill();
setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ } }, 300);

const m = JSON.parse(raw);
if (m.error) { console.log('  ✗ ' + m.error); process.exit(1); }

const u = (v) => +(v * SCALE).toFixed(2);
const box = (b) => {
  const o = { x0: u(b.minX), x1: +(u(b.maxX) + SCALE).toFixed(2), y0: u(b.minY), y1: +(u(b.maxY) + SCALE).toFixed(2) };
  o.cx = +((o.x0 + o.x1) / 2).toFixed(2);
  o.cy = +((o.y0 + o.y1) / 2).toFixed(2);
  return o;
};
const glyph = box(m.glyph);
const tile = box(m.tile);
const green = box(m.green);
const white = box(m.white);
const amber = box(m.amber);
const padL = +(glyph.x0 - tile.x0).toFixed(2);
const padR = +(tile.x1 - glyph.x1).toFixed(2);
const padT = +(glyph.y0 - tile.y0).toFixed(2);
const padB = +(tile.y1 - glyph.y1).toFixed(2);

console.log(`  量测（64 视图单位）：底板 x[${tile.x0},${tile.x1}] y[${tile.y0},${tile.y1}]，图形 x[${glyph.x0},${glyph.x1}] y[${glyph.y0},${glyph.y1}]`);
console.log(`  留白：左 ${padL} 右 ${padR} 上 ${padT} 下 ${padB}\n`);

ok('底板 60×60 且居中于 64×64', Math.abs(tile.cx - 32) <= 0.3 && Math.abs(tile.cy - 32) <= 0.3, `中心 (${tile.cx}, ${tile.cy})`);
ok('图形水平居中（偏差 ≤ 0.8）', Math.abs(glyph.cx - 32) <= 0.8, `中心 x=${glyph.cx}`);
ok('图形垂直居中（偏差 ≤ 0.8）', Math.abs(glyph.cy - 32) <= 0.8, `中心 y=${glyph.cy}`);
ok('左右留白对称（差 ≤ 0.6）', Math.abs(padL - padR) <= 0.6, `左 ${padL} / 右 ${padR}`);
ok('上下留白对称（差 ≤ 0.9）', Math.abs(padT - padB) <= 0.9, `上 ${padT} / 下 ${padB}`);
ok('四周至少留 4 单位边距', Math.min(padL, padR, padT, padB) >= 4, `最小 ${Math.min(padL, padR, padT, padB)}`);
ok('图形占底板宽度 ≥ 60%', (glyph.x1 - glyph.x0) / (tile.x1 - tile.x0) >= 0.6,
  `${(100 * (glyph.x1 - glyph.x0) / (tile.x1 - tile.x0)).toFixed(1)}%`);
// 三节点阶梯构图：白折线从左下走到右上，绿点是已落定的决策、琥珀点是当前刻度，
// 三个元素各占一角 —— 量各自的外缘才锁得住构图。
// 为什么弃掉原来的双轨横档：构图与参考站 logo 同款，视觉资产必须自有
//   @see [Agent Note: 看板首屏降噪与自有 logo](../../.agents/notes/implemented/simplification/2026-09-16-看板首屏降噪与自有-logo.md)
ok('绿节点聚在左下（x<28, y>36）', green.cx < 28 && green.cy > 36, `中心 (${green.cx}, ${green.cy})`);
ok('琥珀节点立在右上（x>40, y<25）', amber.cx > 40 && amber.cy < 25, `中心 (${amber.cx}, ${amber.cy})`);
ok('琥珀是单点元素（宽 ≤ 8）', amber.x1 - amber.x0 <= 8, `宽 ${(amber.x1 - amber.x0).toFixed(2)}`);
ok('白折线横贯全图（x0<20, x1>45）', white.x0 < 20 && white.x1 > 45, `x[${white.x0}, ${white.x1}]`);
ok('绿与琥珀沿对角分离（间隔 ≥ 5）', amber.x0 - green.x1 >= 5, `绿 x1=${green.x1} / 琥珀 x0=${amber.x0}`);

console.log('\n────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
