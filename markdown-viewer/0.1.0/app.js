/* Markdown 查看器 · UI 控制层：入口分发 / 四态状态机 / TOC 滚动联动 / 点击委托 / spark.db 持久化。
 * 事件全部走容器级委托（重渲染后不丢 handler）；所有持久化走 spark.db（默认开放，免授权）。
 *
 * @see [决策笔记 入口与 fs.read 取舍](../../.agents/notes/implemented/architecture/2026-09-16-mdviewer-entry-and-fs-read.md)
 * @see [决策笔记 状态 schema](../../.agents/notes/implemented/feature/2026-09-16-mdviewer-state-schema.md)
 */
(function () {
'use strict';

var $ = function (id) { return document.getElementById(id); };
var app = $('app'), article = $('article'), scroller = $('scroller');
var tocEl = $('toc'), tocList = $('tocList'), tocMask = $('tocMask');
var viewHome = $('viewHome'), viewDoc = $('viewDoc'), viewErr = $('viewErr');
var stL = $('stL'), stR = $('stR'), toastEl = $('toast');
var hasSpark = !!(window.spark && window.spark.fs && window.spark.db);
var S = window.MDV_SOURCE, E = window.MDV_ENGINE;

/* ── spark.db 封装（无宿主时退化为内存，浏览器预览用） ── */
var memDb = {};
var db = {
  async get(k) {
    if (window.spark && window.spark.db) return await window.spark.db.get(k);
    return memDb[k] != null ? memDb[k] : null;
  },
  async set(k, v) {
    if (window.spark && window.spark.db) return await window.spark.db.set(k, v);
    memDb[k] = v;
  }
};
var KEY_RECENT = 'recent', KEY_POS = 'pos', KEY_PREFS = 'prefs', KEY_FONT = 'font_size', KEY_TOC = 'toc_open';

/* ── 基础 UI ── */
var toastTimer = null;
function toast(msg, warn) {
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (warn ? ' warn' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, 1600);
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ── 主题 ── */
var theme = null;
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('btnTheme').classList.toggle('on', false);
}
async function initTheme() {
  var saved = await db.get('theme');
  var initial = (saved === 'light' || saved === 'dark') ? saved
    : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(initial);
}
$('btnTheme').addEventListener('click', async function () {
  var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await db.set('theme', next);
});

/* ── 状态机：home / doc / err ── */
var state = { mode: 'home', lastRaw: '' };
function show(mode) {
  state.mode = mode;
  viewHome.hidden = mode !== 'home';
  viewDoc.hidden = mode !== 'doc';
  viewErr.hidden = mode !== 'err';
  $('btName').textContent = mode === 'doc' && reader ? (reader.name || reader.label) : 'Markdown 查看器';
  $('btPath').textContent = mode === 'doc' && reader ? reader.label : '查看 .md 文件 · 输入 md <路径> 直开';
  updateTocButton();
}

/* ── 字号 ── */
var FONT_MIN = 12, FONT_MAX = 20, FONT_DEFAULT = 15;
var fontTimer = null;
async function initFont() {
  var v = Number(await db.get(KEY_FONT));
  if (!(v >= FONT_MIN && v <= FONT_MAX)) v = FONT_DEFAULT;
  applyFont(v);
}
function applyFont(px) {
  document.documentElement.style.setProperty('--fs-body', px + 'px');
  var tip = '正文字号：' + px + 'px';
  $('btnFontMinus').setAttribute('title', tip);
  $('btnFontPlus').setAttribute('title', tip);
}
function stepFont(d) {
  var cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs-body')) || FONT_DEFAULT;
  var next = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(cur) + d));
  applyFont(next);
  clearTimeout(fontTimer);
  fontTimer = setTimeout(function () { db.set(KEY_FONT, next); }, 300);
}
$('btnFontMinus').addEventListener('click', function () { stepFont(-1); });
$('btnFontPlus').addEventListener('click', function () { stepFont(1); });

/* ── TOC：渲染 / scroll-spy / 点击滚动 ── */
var tocItems = [];
var tocByLevel = [];
function renderToc(toc) {
  tocList.innerHTML = '';
  tocItems = toc;
  tocByLevel = toc.map(function () { return null; });
  $('tocCount').textContent = String(toc.length);
  if (!toc.length) {
    tocList.innerHTML = '<div class="toc-empty">此文件没有标题</div>';
    return;
  }
  var frag = document.createDocumentFragment();
  for (var i = 0; i < toc.length; i++) {
    var item = toc[i];
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'toc-item lv' + Math.min(item.level, 4);
    b.setAttribute('data-idx', String(i));
    b.textContent = item.text;
    b.setAttribute('title', item.text);
    frag.appendChild(b);
  }
  tocList.appendChild(frag);
}
tocList.addEventListener('click', function (e) {
  var btn = e.target.closest && e.target.closest('.toc-item');
  if (!btn) return;
  scrollToHeading(Number(btn.getAttribute('data-idx')));
  if (tocEl.classList.contains('drawer')) toggleDrawer(false);
});
function scrollToHeading(idx) {
  var item = tocItems[idx];
  if (!item) return;
  var el = document.getElementById(item.id);
  if (!el) return;
  spyLock = true;
  var target = Math.max(0, el.offsetTop - 8);
  animateScroll(target, function () {
    setTimeout(function () { spyLock = false; }, 80);
  });
}
/* rAF 平滑滚动 420ms；scrollend 在 WebView2 可能不发，用定时兜底解锁 */
function animateScroll(target, done) {
  var start = scroller.scrollTop, delta = target - start, t0 = null;
  if (Math.abs(delta) < 2) { done && done(); return; }
  function frame(t) {
    if (t0 == null) t0 = t;
    var p = Math.min(1, (t - t0) / 420);
    var eased = 1 - Math.pow(1 - p, 3);
    scroller.scrollTop = start + delta * eased;
    if (p < 1) requestAnimationFrame(frame);
    else done && done();
  }
  requestAnimationFrame(frame);
}
/* scroll-spy：取「最后一个越过顶部 8px 线」的标题；rAF 节流避免滚动布局抖动 */
var spyLock = false, spyScheduled = false, activeIdx = -1;
function spy() {
  spyScheduled = false;
  if (spyLock || state.mode !== 'doc' || !tocItems.length) return;
  var top = scroller.scrollTop + 8;
  var idx = -1;
  for (var i = 0; i < tocItems.length; i++) {
    var el = document.getElementById(tocItems[i].id);
    if (!el) continue;
    if (el.offsetTop <= top) idx = i;
    else break;
  }
  if (idx < 0 && tocItems.length) idx = 0;
  if (idx !== activeIdx) {
    activeIdx = idx;
    var items = tocList.querySelectorAll('.toc-item');
    for (var k = 0; k < items.length; k++) items[k].classList.toggle('active', Number(items[k].getAttribute('data-idx')) === idx);
    var act = tocList.querySelector('.toc-item.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  }
}
scroller.addEventListener('scroll', function () {
  if (!spyScheduled) { spyScheduled = true; requestAnimationFrame(spy); }
  updateFab();
  schedulePos();
}, { passive: true });

/* ── 回到顶部 ── */
function updateFab() { $('btnTop').hidden = scroller.scrollTop < 80; }
$('btnTop').addEventListener('click', function () {
  spyLock = true;
  animateScroll(0, function () { setTimeout(function () { spyLock = false; }, 80); });
});

/* ── TOC 显隐 / 窄窗抽屉 ── */
function updateTocButton() {
  var visible = !tocEl.classList.contains('close') && state.mode === 'doc';
  $('btnToc').classList.toggle('on', visible);
}
function toggleDrawer(open) {
  tocEl.classList.toggle('drawer', open);
  tocEl.classList.toggle('close', !open);
  tocMask.hidden = !open;
  updateTocButton();
}
async function initToc() {
  var saved = await db.get(KEY_TOC);
  tocOpen = saved !== false;
  applyTocLayout();
}
var tocOpen = true;
function applyTocLayout(width) {
  var w = width || window.innerWidth;
  if (w < 880) {
    tocEl.classList.add('drawer');
    tocEl.classList.toggle('close', !tocOpen);
    tocMask.hidden = tocEl.classList.contains('close');
  } else {
    tocEl.classList.remove('drawer');
    tocMask.hidden = true;
    tocEl.classList.toggle('close', !tocOpen);
  }
  updateTocButton();
}
$('btnToc').addEventListener('click', function () {
  if (state.mode !== 'doc') return;
  if (tocEl.classList.contains('drawer')) {
    tocOpen = tocEl.classList.contains('close');
    tocEl.classList.toggle('close', !tocOpen);
    tocMask.hidden = !tocOpen;
  } else {
    tocOpen = !tocOpen;
    tocEl.classList.toggle('close', !tocOpen);
    db.set(KEY_TOC, tocOpen);
  }
  updateTocButton();
});
tocMask.addEventListener('click', function () { toggleDrawer(false); });
window.addEventListener('resize', function () { applyTocLayout(); });

/* TOC 拖宽：180–320，双击复位 */
(function () {
  var handle = $('tocHandle'), dragging = false, w = 232;
  function onMove(e) {
    if (!dragging) return;
    w = Math.min(320, Math.max(180, e.clientX));
    tocEl.style.width = w + 'px';
    e.preventDefault();
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('drag');
    tocEl.style.width = '';
    tocEl.style.minWidth = w + 'px';
    tocEl.style.flexBasis = w + 'px';
    db.set('toc_width', w);
  }
  handle.addEventListener('mousedown', function (e) { dragging = true; handle.classList.add('drag'); e.preventDefault(); });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  handle.addEventListener('dblclick', function () {
    w = 232;
    tocEl.style.minWidth = ''; tocEl.style.flexBasis = '';
    db.set('toc_width', 232);
  });
  db.get('toc_width').then(function (saved) {
    var n = Number(saved);
    if (n >= 180 && n <= 320) {
      w = n;
      tocEl.style.minWidth = w + 'px';
      tocEl.style.flexBasis = w + 'px';
    }
  });
})();

/* ── 阅读位置持久化（debounce 500ms + onClose flush） ── */
var posTimer = null, lastKey = '';
function schedulePos() {
  if (!lastKey || state.mode !== 'doc') return;
  clearTimeout(posTimer);
  posTimer = setTimeout(savePos, 500);
}
async function savePos() {
  if (!lastKey || !tocItems.length) return;
  var max = scroller.scrollHeight - scroller.clientHeight;
  var ratio = max > 0 ? scroller.scrollTop / max : 0;
  var slug = '';
  var top = scroller.scrollTop + 8;
  for (var i = tocItems.length - 1; i >= 0; i--) {
    var el = document.getElementById(tocItems[i].id);
    if (el && el.offsetTop <= top) { slug = tocItems[i].id; break; }
  }
  var pos = (await db.get(KEY_POS)) || {};
  pos[lastKey] = { slug: slug, ratio: Math.max(0, Math.min(1, ratio)), ts: Date.now() };
  var keys = Object.keys(pos);
  if (keys.length > 50) {
    keys.sort(function (a, b) { return (pos[a].ts || 0) - (pos[b].ts || 0); });
    for (var k = 0; k < keys.length - 50; k++) delete pos[keys[k]];
  }
  await db.set(KEY_POS, pos);
}
async function restorePos() {
  if (!lastKey) return;
  var pos = (await db.get(KEY_POS)) || null;
  var saved = pos && pos[lastKey];
  if (!saved) return;
  if (saved.slug) {
    var el = document.getElementById(saved.slug);
    if (el) { scroller.scrollTop = Math.max(0, el.offsetTop - 8); return; }
  }
  if (saved.ratio) {
    var max = scroller.scrollHeight - scroller.clientHeight;
    if (max > 0) scroller.scrollTop = saved.ratio * max;
  }
}

/* ── 最近列表 ── */
async function loadRecent() {
  var recent = (await db.get(KEY_RECENT)) || [];
  var list = $('recentList');
  list.innerHTML = '';
  if (!recent.length) {
    list.innerHTML = '<div class="recent-empty">暂无记录</div>';
    return;
  }
  for (var i = 0; i < recent.length; i++) {
    (function (entry) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'recent-item' + (entry.source === 'fs' ? '' : ' dead');
      row.innerHTML = '<span class="rname">' + esc(entry.name) + '</span><span class="rpath">' +
        esc(entry.path || '') + '</span>' +
        '<span class="rdel" data-del="1" title="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></span>';
      row.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('.rdel')) { removeRecent(entry); return; }
        if (entry.source !== 'fs') { toast('文件句柄不持久，请重新选择', true); return; }
        openByPath(entry.path);
      });
      list.appendChild(row);
    })(recent[i]);
  }
}
async function removeRecent(entry) {
  var recent = (await db.get(KEY_RECENT)) || [];
  recent = recent.filter(function (r) { return !(r.key === entry.key); });
  await db.set(KEY_RECENT, recent);
  loadRecent();
}
$('btnRecentClear').addEventListener('click', async function () {
  await db.set(KEY_RECENT, []);
  loadRecent();
  toast('已清空最近列表');
});
async function addRecent(reader) {
  if (reader.kind === 'file' || reader.kind === 'dir') return; // 句柄不持久，不进最近列表
  var recent = (await db.get(KEY_RECENT)) || [];
  recent = recent.filter(function (r) { return r.key !== reader.key; });
  recent.unshift({ key: reader.key, name: reader.name, path: reader.label, source: 'fs', ts: Date.now() });
  if (recent.length > 10) recent.length = 10;
  await db.set(KEY_RECENT, recent);
}

/* ── 打开与渲染 ── */
var reader = null, currentDirMd = '';
var objectUrls = [];
function revokeUrls() {
  for (var i = 0; i < objectUrls.length; i++) { try { URL.revokeObjectURL(objectUrls[i]); } catch (e) {} }
  objectUrls = [];
}
function showLoadbar(on) {
  clearTimeout(showLoadbar.t);
  if (on) showLoadbar.t = setTimeout(function () { $('loadbar').classList.add('on'); }, 120);
  else { $('loadbar').classList.remove('on'); }
}
function showErr(info, path) {
  show('err');
  $('errTitle').textContent = info.title || '无法读取文件';
  $('errBody').textContent = info.body || '';
  var p = $('errPath');
  if (path) { p.hidden = false; p.textContent = path; $('btnErrCopy').hidden = false; }
  else { p.hidden = true; $('btnErrCopy').hidden = true; }
  stL.textContent = info.title || '出错';
  stR.textContent = '';
}
async function openByPath(raw) {
  if (!E.available()) { showErr({ title: '渲染库缺失', body: 'vendor 脚本未加载完整，请检查插件目录。' }); return; }
  showLoadbar(true);
  try {
    var r = await S.openByPath(raw);
    await renderDoc(r, r.text);
  } catch (e) {
    var info = S.readableErr(e);
    var cands = S.extractCandidates(raw);
    showErr(info, cands[0] || String(raw || ''));
  }
  showLoadbar(false);
}
async function openReader(r, text) {
  showLoadbar(true);
  try {
    if (r.pendingFile) { if (r.pendingFile.size > S.MAX_BYTES) throw S.readableErr({ code: 'TOO_LARGE' }); text = await r.pendingFile.text(); }
    await renderDoc(r, text);
  } catch (e) {
    showErr(S.readableErr(e), r.label);
  }
  showLoadbar(false);
}
async function renderDoc(r, text) {
  revokeUrls();
  reader = r;
  lastKey = r.key;
  currentDirMd = '';
  var res = E.render(text, r, article);

  /* 图片落地：dir 通道 objectURL 加载；remote/ blocked 生成占位 */
  var dirPending = [];
  for (var i = 0; i < res.pendingImgs.length; i++) {
    var img = res.pendingImgs[i];
    var cat = img.getAttribute('data-img');
    if (cat === 'pending') dirPending.push(img);
    else makeImagePlaceholder(img, cat === 'remote' ? '远程图片无法加载（插件页面禁网）' : '本通道不支持本地图片');
  }
  for (var p = 0; p < dirPending.length; p++) {
    await loadDirImage(dirPending[p]);
  }

  renderToc(res.toc);
  activeIdx = -1;
  show('doc');
  scroller.scrollTop = 0;
  applyTocLayout();

  var sizeInfo = fmtSize(new Blob([text]).size);
  var encInfo = 'UTF-8';
  stL.textContent = encInfo + ' · ' + sizeInfo + ' · ' + (reader.describe ? reader.describe() : '');
  stR.innerHTML = res.textLen.toLocaleString() + ' 字 · 大纲 ' + res.toc.length + ' · <span class="pct">0%</span>';
  updateFab();
  updateProgress();
  await addRecent(r);
  await restorePos();
  spy();
  if (window.spark && window.spark.window && r.name) {
    try { await window.spark.window.setTitle(r.name + ' — Markdown 查看器'); } catch (e) {}
  }
}
function makeImagePlaceholder(img, why) {
  var alt = img.getAttribute('alt') || '';
  var doc = img.ownerDocument;
  var fig = doc.createElement('div');
  fig.className = 'img-ph';
  fig.innerHTML = '<div class="ph-ic">🖼</div><div class="ph-alt">' + esc(alt || '(无 alt 文本)') + '</div><div class="ph-why">' + esc(why) + '</div>';
  img.parentNode.insertBefore(fig, img);
  img.remove();
}
async function loadDirImage(img) {
  var src = img.getAttribute('data-src') || '';
  var base = reader.dir ? S.joinPath(reader.dir, src) : src;
  var blob = null;
  try { blob = await reader.readBlob(base); } catch (e) { blob = null; }
  if (blob) {
    var url = URL.createObjectURL(blob);
    objectUrls.push(url);
    img.src = url;
    img.removeAttribute('data-pending');
  } else {
    makeImagePlaceholder(img, '目录内找不到图片：' + src);
  }
}
function updateProgress() {
  var max = scroller.scrollHeight - scroller.clientHeight;
  var pct = max > 0 ? Math.round((scroller.scrollTop / max) * 100) : 0;
  var pctEl = stR.querySelector('.pct');
  if (pctEl) pctEl.textContent = pct + '%';
}
scroller.addEventListener('scroll', updateProgress);

/* ── 点击委托：链接四分流 + 代码块复制 ── */
article.addEventListener('click', async function (e) {
  var copyBtn = e.target.closest && e.target.closest('.code-copy');
  if (copyBtn) {
    var box = copyBtn.closest('.code');
    var codeEl = box && box.querySelector('pre code');
    var ok = await copyText(codeEl ? codeEl.textContent : '');
    flashCopy(copyBtn, ok, '已复制代码');
    e.preventDefault();
    return;
  }
  var a = e.target.closest && e.target.closest('a[data-link], a[href]');
  if (!a) return;
  var kind = a.getAttribute('data-link');
  var href = a.getAttribute('href') || a.getAttribute('data-href') || '';
  e.preventDefault();
  if (kind === 'anchor') {
    var el = document.getElementById(href.replace(/^#/, ''));
    if (el) { spyLock = true; animateScroll(Math.max(0, el.offsetTop - 8), function () { setTimeout(function () { spyLock = false; }, 80); }); }
    return;
  }
  if (kind === 'external') {
    /* 安全收口：只放行 http(s)（classifyLink 已筛），本地路径绝不透传 openExternal */
    try {
      if (window.spark && window.spark.shell) await window.spark.shell.openExternal(href);
      else toast('浏览器预览模式，无法打开外链', true);
    } catch (err) { toast('打开外链失败：' + (err.message || err), true); }
    return;
  }
  if (kind === 'internal') {
    var target = S.norm(href.split('#')[0]);
    var anchor = href.indexOf('#') >= 0 ? href.slice(href.indexOf('#') + 1) : '';
    if (reader && reader.kind === 'dir') {
      if (reader.hasFile(target)) {
        var text = await reader.readText(target);
        await renderDoc(reader, text);
        if (anchor) setTimeout(function () {
          var el = document.getElementById('md-' + slugOf(anchor));
          if (el) animateScroll(Math.max(0, el.offsetTop - 8));
        }, 100);
      } else toast('目录内找不到：' + target, true);
    } else if (reader && reader.kind === 'fs') {
      var joined = S.joinPath(reader.dir, target);
      openByPath(joined);
    } else {
      toast('单文件模式不支持站内跳转，可用「打开」选择目录', true);
    }
    return;
  }
});
function slugOf(text) {
  var s = String(text).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'section';
}
async function copyText(text) {
  if (window.spark && window.spark.clipboard) {
    try { await window.spark.clipboard.writeText(text); return true; } catch (e) {}
  }
  try {
    var t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    var ok = document.execCommand('copy');
    t.remove();
    return ok;
  } catch (e) { return false; }
}
function flashClass(btn, cls) {
  btn.classList.add(cls);
  setTimeout(function () { btn.classList.remove(cls); }, 1400);
}
function flashCopy(btn, ok, msg) {
  flashClass(btn, ok ? 'ok' : 'bad');
  if (msg) toast(ok ? msg : '复制失败 — 请手动选中后 Ctrl+C', !ok);
}
$('btnCopyAll').addEventListener('click', async function () {
  if (state.mode !== 'doc') { toast('还没有打开文件', true); return; }
  var text = article.textContent || '';
  var ok = await copyText(text);
  toast(ok ? '已复制全文（' + text.length.toLocaleString() + ' 字）' : '复制失败', !ok);
});

/* ── 手选文件 / 目录 ── */
$('btnPickFile').addEventListener('click', function () { $('fileInput').click(); });
$('btnErrPick').addEventListener('click', function () { $('fileInput').click(); });
$('fileInput').addEventListener('change', async function () {
  var f = this.files && this.files[0];
  this.value = '';
  try {
    var r = S.pickSingleFile(f);
    await openReader(r, null);
  } catch (e) {
    if (e && e.code !== 'CANCELLED') showErr(S.readableErr(e));
  }
});
$('dirInput').addEventListener('change', async function () {
  var files = this.files;
  this.value = '';
  try {
    var r = S.pickDir(files);
    /* 目录模式默认开目录里第一个 .md；记录它供「重新加载」用 */
    var mds = r.listMd();
    if (!mds.length) { toast('所选目录里没有 .md 文件', true); return; }
    currentDirMd = mds[0];
    await renderDoc(r, await r.readText(currentDirMd));
  } catch (e) {
    if (e && e.code !== 'CANCELLED') showErr(S.readableErr(e));
  }
});
/* 「打开」按钮：单击选文件，Shift+单击选目录（目录模式才能解析相对图片与站内跳转） */
$('btnOpen').addEventListener('click', function (e) {
  if (e.shiftKey) $('dirInput').click(); else $('fileInput').click();
});
$('btnReload').addEventListener('click', async function () {
  if (!reader) return;
  if (reader.kind === 'fs') openByPath(reader.label);
  else if (reader.pendingFile) openReader(reader, null);
  else if (reader.kind === 'dir' && currentDirMd) renderDoc(reader, await reader.readText(currentDirMd));
});
$('btnErrRetry').addEventListener('click', function () {
  if (state.lastRaw) openByPath(state.lastRaw);
});
$('btnErrCopy').addEventListener('click', async function () {
  var ok = await copyText($('errPath').textContent || '');
  toast(ok ? '已复制路径' : '复制失败', !ok);
});
$('btFile').addEventListener('click', async function () {
  if (state.mode === 'doc' && reader) {
    var path = reader.label || '';
    var ok = await copyText(path);
    toast(ok ? '已复制路径：' + path : '复制失败', !ok);
  }
});

/* 拖拽打开：单 .md 文件 / 目录 */
var dz = $('dropzone');
var dragDepth = 0;
document.addEventListener('dragenter', function (e) {
  if (state.mode === 'home' || state.mode === 'doc' || state.mode === 'err') {
    dragDepth++;
    dz.hidden = false;
    e.preventDefault();
  }
});
document.addEventListener('dragover', function (e) { e.preventDefault(); });
document.addEventListener('dragleave', function (e) {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dz.hidden = true;
  e.preventDefault();
});
document.addEventListener('drop', async function (e) {
  e.preventDefault();
  dragDepth = 0;
  dz.hidden = true;
  var files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  var f = files[0];
  if (/^\.(md|markdown|mdx|txt)$/i.test(S.extName(f.name))) {
    try { await openReader(S.pickSingleFile(f), null); } catch (err) { showErr(S.readableErr(err)); }
  } else {
    toast('请拖入 .md 文件（目录请用「打开」）', true);
  }
});

/* ── 通知权限：错误提示页内 toast 足够，本插件不声明 notify ── */

/* ── spark 事件：入口分发 + 生命周期 ── */
var bootRaw = null;
if (window.spark && window.spark.input) {
  bootRaw = String(window.spark.input.text || '').trim();
  state.lastRaw = bootRaw;
}
function boot() {
  initTheme();
  initFont();
  initToc();
  loadRecent();
  applyTocLayout();
  if (bootRaw) {
    /* 带路径进来：直接开；纯空参：主页空态（手选入口在空态里） */
    S.openByPath(bootRaw).then(function (r) {
      return renderDoc(r, r.text);
    }).catch(function (e) {
      var cands = S.extractCandidates(bootRaw);
      showErr(S.readableErr(e), cands[0] || bootRaw);
    });
  }
}
if (window.spark && window.spark.onClose) {
  window.spark.onClose(function () {
    try { savePos(); } catch (e) {}
  });
}
if (window.spark && window.spark.onResize) {
  window.spark.onResize(function () { applyTocLayout(); });
}
if (window.spark && window.spark.onEnter) window.spark.onEnter(boot);
else boot();
})();

/* ── 键盘（页面加固之上的业务键） ── */
document.addEventListener('keydown', function (e) {
  var k = (e.key || '').toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (k === '=' || k === '+')) { stepFont(1); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && k === '-') { stepFont(-1); e.preventDefault(); }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && k === '0') { applyFont(FONT_DEFAULT); db.set(KEY_FONT, FONT_DEFAULT); e.preventDefault(); }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && k === 'b') {
    if (state.mode === 'doc') $('btnToc').click();
    e.preventDefault();
  }
  if ((e.ctrlKey || e.metaKey) && e.altKey && k === 'c') {
    $('btnCopyAll').click();
    e.preventDefault();
  }
}, true);

/* ── 页面加固：屏蔽默认右键菜单与浏览器快捷键 ── */
document.addEventListener('contextmenu', function (e) {
  // 输入框/文本域保留系统菜单（剪切/复制/粘贴）
  if (e.target && e.target.closest && e.target.closest('input, textarea')) return;
  e.preventDefault();
});
document.addEventListener('keydown', function (e) {
  var k = (e.key || '').toLowerCase();
  var editing = e.target && e.target.closest && e.target.closest('input, textarea');
  // DevTools / 打印 / 刷新：任何焦点都拦（F12、F5、Ctrl+Shift+I/J/C、Ctrl+P）
  if (k === 'f12' || k === 'f5' ||
      (e.shiftKey && (e.ctrlKey || e.metaKey) && (k === 'i' || k === 'j' || k === 'c')) ||
      ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'p')) {
    e.preventDefault();
    return;
  }
  // Ctrl+R：输入框/文本域内放行；其余位置（会整页刷新）拦截
  if (!editing && (e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'r') {
    e.preventDefault();
  }
}, true);