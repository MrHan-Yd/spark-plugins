/* Linux 命令查询 · UI 层(状态机/详情/键盘/复制链/主题/页面加固)
 * 职责分层:engine.js 搜索纯函数 · list.js 列表渲染域 · doc.js md 渲染管线 · updater.js 联网。
 * 此文件只做状态机与接线。无 Spark 宿主时:db 回退 localStorage,检查更新按「无联网能力」降级。
 */
(function () {
'use strict';

var E = window.LCMD_ENGINE, DOC = window.LCMD_DOC, UPD = window.LCMD_UPDATER, LIST = window.LCMD_LIST;
var META = window.LCMD_META || { upstream: '', built: '', count: 0, letters: [] };
var sparkApi = window.spark || null;

var $ = function (id) { return document.getElementById(id); };
var els = {
  q: $('q'), btnClr: $('btn-clr'), scopeChip: $('scope-chip'),
  scopeLabel: $('scope-label'), btnTheme: $('btn-theme'),
  alpha: $('alpha'), btnFavs: $('btn-favs'),
  list: $('list'), listEmpty: $('list-empty'), sentinel: $('sentinel'),
  docPane: $('doc-pane'), docHead: $('doc-head'), docTitle: $('doc-title'),
  btnBack: $('btn-back'), btnCopyCmd: $('btn-copy-cmd'), btnStar: $('btn-star'),
  docScroll: $('doc-scroll'), rail: $('rail'),
  docIdle: $('doc-idle'), docEmpty: $('doc-empty'), skel: $('skel'), md: $('md'),
  toc: $('toc'), tocSum: $('toc-sum'), tocList: $('toc-list'), tocCount: $('toc-count'),
  srcDot: $('src-dot'), srcText: $('src-text'), btnRestore: $('btn-restore'),
  btnUpd: $('btn-upd'), updProg: $('upd-prog'), progFill: $('prog-fill'), progText: $('prog-text'),
  toast: $('toast')
};

var FACTORY_NAMES = {};
for (var fi = 0; fi < (window.LCMD_INDEX || []).length; fi++) FACTORY_NAMES[window.LCMD_INDEX[fi].n] = true;

/* ── 偏好持久化(spark.db 优先,浏览器预览回退 localStorage) ── */

var DEFAULTS = { theme: 'dark', favs: [], recents: [] };
var prefs = { theme: 'dark', favs: [], recents: [] };
var favSet = new Set();
var saveTimer = null;

function loadPrefs() {
  if (sparkApi && sparkApi.db) {
    var p;
    try { p = sparkApi.db.get('prefs'); } catch (e) { p = null; }
    return Promise.resolve(p).catch(function () { return null; }).then(function (raw) {
      if (raw && typeof raw === 'object') prefs = Object.assign({}, DEFAULTS, raw);
      if (!Array.isArray(prefs.favs)) prefs.favs = [];
      if (!Array.isArray(prefs.recents)) prefs.recents = [];
    });
  }
  try {
    var raw = JSON.parse(localStorage.getItem('lcmd_prefs') || 'null');
    if (raw) prefs = Object.assign({}, DEFAULTS, raw);
    if (!Array.isArray(prefs.favs)) prefs.favs = [];
    if (!Array.isArray(prefs.recents)) prefs.recents = [];
  } catch (e) { /* 忽略 */ }
  return Promise.resolve();
}

function savePrefs(immediate) {
  if (sparkApi && sparkApi.db) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    var write = function () { try { sparkApi.db.set('prefs', prefs); } catch (e) { /* 忽略 */ } };
    if (immediate) write(); /* 关窗路径立即冲刷,防抖定时器等不到跑 */
    else saveTimer = setTimeout(write, 300);
  } else {
    try { localStorage.setItem('lcmd_prefs', JSON.stringify(prefs)); } catch (e) { /* 忽略 */ }
  }
}

/* ── 状态 ── */

var state = {
  q: '', letter: null, favsOnly: false,
  index: window.LCMD_INDEX || [],     // 合并覆盖层后的运行时索引
  results: [], rendered: 0,
  selName: null, openName: null
};
var io = null;

/* ── 工具 ── */

function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

var toastTimer = null, toastHideTimer = null;
function toast(msg, isErr) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('err', !!isErr);
  els.toast.hidden = false;
  els.toast.classList.remove('hide');
  els.toast.classList.add('show');
  clearTimeout(toastTimer); clearTimeout(toastHideTimer);
  toastTimer = setTimeout(function () {
    els.toast.classList.remove('show');
    els.toast.classList.add('hide');
    toastHideTimer = setTimeout(function () { els.toast.classList.remove('hide'); els.toast.hidden = true; }, 200);
  }, 1800);
}

function copyText(v, btn) {
  var p = sparkApi && sparkApi.clipboard
    ? sparkApi.clipboard.writeText(v)
    : (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject({ code: 'PERMISSION_DENIED' }));
  p.then(function () {
    toast('已复制 ' + (v.length > 40 ? v.slice(0, 40) + '…' : v));
    if (btn) {
      btn.classList.add('copied', 'pop');
      if (btn._copiedTimer) clearTimeout(btn._copiedTimer);
      btn._copiedTimer = setTimeout(function () { btn.classList.remove('copied', 'pop'); btn._copiedTimer = null; }, 900);
    }
  }).catch(function (e) {
    toast(e && e.code === 'PERMISSION_DENIED' ? '复制失败:请在 设置-插件 中授权剪贴板' : '复制失败', true);
  });
}

/* 动效播完立即摘类:display 切换会取消动画,残留类会在元素恢复显示时整段重放 */
document.addEventListener('animationend', function (e) {
  var t = e.target;
  if (!t || !t.classList) return;
  if (t.classList.contains('anim-in')) t.classList.remove('anim-in');
  if (t.classList.contains('pop')) t.classList.remove('pop');
  if (t.id === 'rail' && t.classList.contains('anim')) t.classList.remove('anim');
  if (t.id === 'toast') { t.classList.remove('show'); }
});

/* ── 索引合并(出厂 + 覆盖层,覆盖层只增不替换) ── */

function rebuildIndex(overlay) {
  var all = (window.LCMD_INDEX || []).slice();
  var added = 0;
  if (overlay && Array.isArray(overlay.added)) {
    var seen = {};
    for (var i = 0; i < all.length; i++) seen[all[i].n] = true;
    for (var k = 0; k < overlay.added.length; k++) {
      var e = overlay.added[k];
      /* 去重:出厂同名条目优先,覆盖层脏数据/重复项一律跳过 */
      if (!e || !e.n || seen[e.n] || FACTORY_NAMES[e.n]) continue;
      seen[e.n] = true;
      all.push({ n: e.n, d: e.d, py: '', pi: '' });
      added++;
    }
  }
  state.index = all;
  overlayCount = added;
  applyFooterOverlay();
}

var overlayCount = 0;
function applyFooterOverlay() {
  els.btnRestore.hidden = overlayCount === 0;
  if (overlayCount > 0) {
    els.srcDot.classList.add('online');
    els.srcText.textContent = '在线索引 · +' + overlayCount + ' 条 · 出厂 ' + META.upstream;
  } else {
    els.srcDot.classList.remove('online');
    els.srcText.textContent = '出厂数据 · ' + META.upstream + ' · ' + META.count + ' 条';
  }
}

/* ── 查询 ── */

var runDebounced = debounce(function () { runQuery(true); }, 120);

function runQuery(rebuild) {
  state.q = els.q.value.trim();
  state.results = E.query(state.index, {
    q: state.q, letter: state.letter, favsOnly: state.favsOnly, favSet: favSet
  });
  /* 悬空选中清理:结果集重建后,旧 selName 不在新结果中即作废,防 Enter 打开被淘汰的旧命令 */
  if (state.selName) {
    var alive = false;
    for (var i = 0; i < state.results.length; i++) {
      if (state.results[i].entry.n === state.selName) { alive = true; break; }
    }
    if (!alive) state.selName = null;
  }
  applyScopeChip();
  LIST.renderList(rebuild);
}

function clearQuery() {
  els.q.value = '';
  els.btnClr.hidden = true;
  runQuery(true);
  els.q.focus();
}

/* ── scope(字母 / 收藏,单选互斥) ── */

function setLetter(letter) {
  state.letter = (state.letter === letter) ? null : letter;
  if (state.letter) state.favsOnly = false;
  applyAlpha(); applyFavBtn();
  runQuery(true);
}

function setFavsOnly(on) {
  state.favsOnly = (on === undefined) ? !state.favsOnly : !!on;
  if (state.favsOnly) state.letter = null;
  applyAlpha(); applyFavBtn();
  runQuery(true);
}

function applyAlpha() {
  var btns = els.alpha.querySelectorAll('.l');
  for (var i = 0; i < btns.length; i++) {
    var L = btns[i].getAttribute('data-letter');
    btns[i].classList.toggle('on', state.letter === L && !state.favsOnly);
  }
}

function applyFavBtn() {
  els.btnFavs.setAttribute('aria-pressed', String(state.favsOnly));
}

function applyScopeChip() {
  var active = state.favsOnly || state.letter;
  els.scopeChip.hidden = !active;
  if (state.favsOnly) els.scopeLabel.textContent = '收藏';
  else if (state.letter) els.scopeLabel.textContent = '字母 · ' + state.letter.toUpperCase();
}

function buildAlpha() {
  var frag = document.createDocumentFragment();
  var letters = META.letters || [];
  for (var i = 0; i < 26; i++) {
    var L = String.fromCharCode(97 + i);
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'l';
    b.setAttribute('data-letter', L);
    b.textContent = L.toUpperCase();
    if (letters.indexOf(L) < 0) b.classList.add('off');
    else b.addEventListener('click', function (ev) { setLetter(ev.currentTarget.getAttribute('data-letter')); });
    frag.appendChild(b);
  }
  els.alpha.appendChild(frag);
}

/* ── 收藏 / 最近查看 ── */

function toggleFav(name, starEl) {
  var i = prefs.favs.indexOf(name);
  if (i >= 0) prefs.favs.splice(i, 1); else prefs.favs.push(name);
  favSet = new Set(prefs.favs);
  savePrefs();
  popStar(starEl);
  if (name === state.openName) els.btnStar.classList.toggle('starred', favSet.has(name));
  var rows = els.list.querySelectorAll('.row');
  for (var r = 0; r < rows.length; r++) {
    if (rows[r].getAttribute('data-name') === name) {
      var s = rows[r].querySelector('.row-star');
      if (s) { s.classList.toggle('starred', favSet.has(name)); popStar(s); }
    }
  }
  if (state.favsOnly) runQuery(true);
}

function popStar(el) {
  if (!el) return;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

function pushRecent(name) {
  var at = prefs.recents.indexOf(name);
  if (at >= 0) prefs.recents.splice(at, 1);
  prefs.recents.unshift(name);
  if (prefs.recents.length > 20) prefs.recents.length = 20;
  savePrefs();
}

/* ── 详情 ── */

function showDetailShell() {
  els.docHead.hidden = false;
  els.docIdle.hidden = true;
  els.docEmpty.hidden = true;
  els.md.hidden = true;
  els.toc.hidden = true;
  els.skel.hidden = false;
}

function showDocEmpty(title, detail, retry) {
  els.skel.hidden = true;
  els.md.hidden = true;
  els.toc.hidden = true;
  els.docEmpty.hidden = false;
  els.docEmpty.textContent = '';
  var d = document.createElement('div');
  d.className = 'empty';
  d.innerHTML = '<i class="ic ic-file-x"></i><div class="empty-t"></div><div class="empty-s"></div>';
  d.querySelector('.empty-t').textContent = title;
  d.querySelector('.empty-s').textContent = detail;
  if (retry) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-btn';
    b.textContent = '重试';
    b.addEventListener('click', function () { openDoc(state.openName); });
    d.appendChild(b);
  }
  els.docEmpty.appendChild(d);
}

function renderToc(headings) {
  els.tocList.textContent = '';
  if (headings.length < 3) {
    els.toc.hidden = true;
    els.toc.classList.remove('open');
    els.tocSum.setAttribute('aria-expanded', 'false');
    return;
  }
  els.tocCount.textContent = headings.length + ' 节';
  for (var i = 0; i < headings.length; i++) {
    var h = headings[i];
    var li = document.createElement('li');
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = h.text;
    if (h.level === 3) b.style.paddingLeft = '20px';
    (function (id) {
      b.addEventListener('click', function () {
        var t = els.md.querySelector('#' + id);
        if (t && typeof t.scrollIntoView === 'function') t.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    })(h.id);
    li.appendChild(b);
    els.tocList.appendChild(li);
  }
  els.toc.hidden = false;
  els.toc.classList.remove('open');
  els.tocSum.setAttribute('aria-expanded', 'false');
}

function openDoc(name) {
  if (!name) return;
  state.openName = name;
  state.selName = name;
  showDetailShell();
  els.docTitle.textContent = name;
  els.btnStar.classList.toggle('starred', favSet.has(name));
  var letter = E.letterOf(name);
  var inFactory = !!FACTORY_NAMES[name];
  var go = function (md) {
    els.skel.hidden = true;
    els.md.hidden = false;
    els.md.textContent = '';
    var res = DOC.render(md, els.md);
    els.rail.classList.remove('anim');
    void els.rail.offsetWidth;
    els.rail.classList.add('anim');
    renderToc(res.headings);
    els.docScroll.scrollTop = 0;
    pushRecent(name);
    LIST.syncSelRow();
    if (isNarrow()) docPaneOpen(true);
  };
  if (!inFactory) {
    /* 覆盖层新命令:正文不在出厂分块,按需联网拉取(db 缓存) */
    UPD.fetchDoc(name).then(go).catch(function (e) {
      showDocEmpty('文档加载失败', (e && e.message) || '网络不可用', true);
    });
    return;
  }
  E.ensureChunk(letter, 'data/').then(function () {
    var md = (window.LCDC_DOCS && window.LCDC_DOCS[letter] ? window.LCDC_DOCS[letter][name] : null);
    if (typeof md === 'string' && md.length > 0) go(md);
    else showDocEmpty('文档缺失', '分块中无「' + name + '」的正文', false);
  }).catch(function (e) {
    showDocEmpty('文档加载失败', (e && e.message) || '分块加载失败', true);
  });
}

function closeDoc() {
  state.openName = null;
  els.docHead.hidden = true;
  els.md.hidden = true;
  els.toc.hidden = true;
  els.docEmpty.hidden = true;
  els.docIdle.hidden = false;
  docPaneOpen(false);
  LIST.syncSelRow();
}

/* 窄窗盖层开合(关 190ms / 开 260ms 由 CSS 双向时长处理,JS 只切类) */
function isNarrow() {
  return window.matchMedia('(max-width: 819px)').matches;
}
function docPaneOpen(open) {
  els.docPane.classList.toggle('open', !!open);
}

/* ── 键盘(↑↓/Enter 委托 list.js 的选行;Esc 逐级退出) ── */

function openSelected() {
  if (state.selName) {
    var alive = false;
    for (var i = 0; i < state.results.length; i++) {
      if (state.results[i].entry.n === state.selName) { alive = true; break; }
    }
    if (!alive) state.selName = null;
  }
  if (!state.selName) {
    if (state.results.length) state.selName = state.results[0].entry.n;
    else return;
  }
  openDoc(state.selName);
}

document.addEventListener('keydown', function (e) {
  var key = e.key;
  var editing = e.target && e.target.closest && e.target.closest('input, textarea');
  if (key === 'Escape') {
    if (isNarrow() && els.docPane.classList.contains('open')) { els.docPane.classList.remove('open'); e.preventDefault(); return; }
    if (state.openName) { closeDoc(); e.preventDefault(); return; }
    if (state.q) { clearQuery(); e.preventDefault(); return; }
    if (state.favsOnly || state.letter) { state.favsOnly = false; state.letter = null; applyAlpha(); applyFavBtn(); runQuery(true); e.preventDefault(); }
    return;
  }
  if (isNarrow() && els.docPane.classList.contains('open')) return; /* 盖层打开期间忽略列表键 */
  if (!editing && key === '/') { e.preventDefault(); focusWithPulse(); return; }
  if (key === 'ArrowDown') { e.preventDefault(); LIST.moveSel(1); return; }
  if (key === 'ArrowUp') { e.preventDefault(); LIST.moveSel(-1); return; }
  if (key === 'Enter' && editing) { e.preventDefault(); openSelected(); }
});

/* ── 主题 ── */

function applyTheme() {
  document.documentElement.setAttribute('data-theme', prefs.theme);
}
els.btnTheme.addEventListener('click', function () {
  prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
  savePrefs();
  applyTheme();
});

/* ── 页脚:检查更新 / 恢复出厂 ── */

function setUpdBusy(busy, pct, text) {
  els.btnUpd.classList.toggle('busy', !!busy);
  els.btnUpd.hidden = !!busy;
  els.updProg.hidden = !busy;
  /* 更新在途时锁定恢复出厂,防并发写回覆盖层(updater 代际闸兜底) */
  els.btnRestore.disabled = !!busy;
  if (busy) {
    els.progFill.style.width = (pct || 0) + '%';
    els.progText.textContent = text || '';
  }
}

els.btnUpd.addEventListener('click', function () {
  if (!UPD.available()) { toast('宿主无联网能力,无法检查更新', true); return; }
  if (els.btnUpd.classList.contains('busy')) return;
  setUpdBusy(true, 4, '读取覆盖层…');
  UPD.checkIndex({ onProgress: function (pct, text) { setUpdBusy(true, pct, text); } }).then(function (res) {
    setUpdBusy(false);
    if (res.cancelled) return; /* 期间已恢复出厂,本次更新作废:不重建列表、不打扰 */
    rebuildIndex(res.overlay);
    LIST.renderList(true);
    if (res.added.length > 0) toast('更新完成,新增 ' + res.added.length + ' 条命令');
    else toast('已是最新(远端 ' + res.totalRemote + ' 条)');
  }).catch(function (e) {
    setUpdBusy(false);
    toast('更新失败:' + ((e && e.message) || '网络不可用'), true);
  });
});

els.btnRestore.addEventListener('click', function () {
  if (els.btnRestore.disabled) return;
  els.btnRestore.disabled = true;
  UPD.clearOverlay().then(function () {
    return UPD.loadOverlay();
  }).then(function (overlay) {
    rebuildIndex(overlay);
    LIST.renderList(true);
    toast('已恢复出厂索引');
  }).catch(function (e) {
    toast('恢复出厂失败:' + ((e && e.message) || '未知原因'), true);
  }).then(function () {
    els.btnRestore.disabled = false;
  });
});

/* ── 事件接线 ── */

els.q.addEventListener('input', function () {
  els.btnClr.hidden = els.q.value === '';
  runDebounced();
  /* 窄窗:搜索输入时自动收回详情盖层,回到结果列表 */
  if (isNarrow() && els.docPane.classList.contains('open')) els.docPane.classList.remove('open');
});
els.btnClr.addEventListener('click', clearQuery);
els.scopeChip.addEventListener('click', function () {
  state.favsOnly = false; state.letter = null;
  applyAlpha(); applyFavBtn(); applyScopeChip();
  runQuery(true);
});
els.btnFavs.addEventListener('click', function () { setFavsOnly(); });

els.list.addEventListener('click', function (e) {
  var row = e.target && e.target.closest ? e.target.closest('.row') : null;
  if (!row) return;
  state.selName = row.getAttribute('data-name');
  openDoc(state.selName);
});

els.sentinel.hidden = true;
if (typeof IntersectionObserver === 'function') {
  io = new IntersectionObserver(function (entries) {
    if (entries && entries[0] && entries[0].isIntersecting) LIST.renderMore();
  }, { root: els.list, rootMargin: '400px' });
  io.observe(els.sentinel);
}

/* 详情头/代码块复制:统一复制链 + 对勾反馈 */
els.btnCopyCmd.addEventListener('click', function () { copyText(state.openName || els.docTitle.textContent, els.btnCopyCmd); });
els.btnStar.addEventListener('click', function () { toggleFav(state.openName, els.btnStar); });
els.md.addEventListener('click', function (e) {
  var btn = e.target && e.target.closest ? e.target.closest('.code-copy') : null;
  if (!btn) return;
  var code = btn.parentNode ? btn.parentNode.querySelector('pre > code, pre code') : null;
  if (code) copyText(code.textContent, btn);
});
els.tocSum.addEventListener('click', function () {
  var open = els.toc.classList.toggle('open');
  els.tocSum.setAttribute('aria-expanded', String(open));
});
els.btnBack.addEventListener('click', closeDoc);

/* ── 页面加固:屏蔽默认右键菜单与浏览器快捷键 ── */
document.addEventListener('contextmenu', function (e) {
  if (e.target && e.target.closest && e.target.closest('input, textarea')) return;
  e.preventDefault();
});
document.addEventListener('keydown', function (e) {
  var k = (e.key || '').toLowerCase();
  var editing = e.target && e.target.closest && e.target.closest('input, textarea');
  if (k === 'f12' || k === 'f5' ||
      (e.shiftKey && (e.ctrlKey || e.metaKey) && (k === 'i' || k === 'j' || k === 'c')) ||
      ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'p')) {
    e.preventDefault();
    return;
  }
  if (!editing && (e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'r') {
    e.preventDefault();
  }
}, true);

/* ── 初始化 ── */

function init() {
  /* 页脚标签由 rebuildIndex→applyFooterOverlay 统一设置(含覆盖层在线态),此处不再覆盖 */
  var pre = sparkApi && sparkApi.input && sparkApi.input.text ? String(sparkApi.input.text).trim() : '';
  if (pre) { els.q.value = pre; els.btnClr.hidden = false; }
  runQuery(true);
  focusWithPulse();
}

function focusWithPulse() {
  els.q.focus();
  els.q.classList.remove('pulse');
  void els.q.offsetWidth;
  els.q.classList.add('pulse');
  try { els.q.setSelectionRange(els.q.value.length, els.q.value.length); } catch (e) { /* type=search 部分引擎不支持 */ }
}

/* 载入覆盖层后初始化;宿主 onEnter 才进入(浏览器预览直接跑) */
function boot() {
  loadPrefs().then(function () {
    applyTheme();
    return UPD.loadOverlay();
  }).then(function (overlay) {
    rebuildIndex(overlay);
  }).catch(function () {
    rebuildIndex(null);
  }).then(function () {
    LIST.init({
      els: { list: els.list, sentinel: els.sentinel, listEmpty: els.listEmpty },
      state: function () { return state; },
      favs: function () { return favSet; },
      recents: function () { return prefs.recents; },
      onStar: toggleFav,
      onOpen: openDoc,
      onClear: clearQuery
    });
    buildAlpha();
    init();
  });
}

if (sparkApi && sparkApi.onEnter) {
  sparkApi.onEnter(function () { boot(); });
  if (sparkApi.onClose) sparkApi.onClose(function () { savePrefs(true); /* 立即冲刷,防抖窗口内关窗不丢收藏 */ });
} else {
  boot();
}
})();