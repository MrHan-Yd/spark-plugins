/* Linux 命令查询 · 列表渲染域(行构建/分批续渲染/空态/键盘选行)
 * 无状态模块:boot 时由 app.js 注入 ctx(els/state/收藏查询/回调),自身不持有任何可变状态。
 * M1 约束:入场动画只给 rebuild 首批前 8 行加 anim-in;续批(fresh=false)永不重播。
 */
(function (global) {
'use strict';

var ctx = null;

function init(deps) { ctx = deps; }
function need() { if (!ctx) throw new Error('LCMD_LIST 未初始化'); }

/* ── 行构建(textContent 拼装,无 innerHTML 注入面) ── */

function rowHitHtml(text, hit) {
  var frag = global.document.createDocumentFragment();
  if (!hit) { frag.appendChild(global.document.createTextNode(text)); return frag; }
  if (hit[0] > 0) frag.appendChild(global.document.createTextNode(text.slice(0, hit[0])));
  var h = global.document.createElement('span');
  h.className = 'hit';
  h.textContent = text.slice(hit[0], hit[1]);
  frag.appendChild(h);
  if (hit[1] < text.length) frag.appendChild(global.document.createTextNode(text.slice(hit[1])));
  return frag;
}

function descHtml(e, ranges) {
  var doc = global.document;
  var frag = doc.createDocumentFragment();
  if (!ranges || !ranges.length) { frag.appendChild(doc.createTextNode(e.d)); return frag; }
  var cur = 0;
  for (var i = 0; i < ranges.length && cur < e.d.length; i++) {
    var s = Math.max(cur, ranges[i][0]), t = ranges[i][1];
    if (s > cur) frag.appendChild(doc.createTextNode(e.d.slice(cur, s)));
    if (t > s) {
      var h = doc.createElement('span');
      h.className = 'hit';
      h.textContent = e.d.slice(s, Math.min(t, e.d.length));
      frag.appendChild(h);
      cur = Math.max(cur, t);
    }
  }
  if (cur < e.d.length) frag.appendChild(doc.createTextNode(e.d.slice(cur)));
  return frag;
}

function makeRow(r, animDelay) {
  need();
  var doc = global.document;
  var row = doc.createElement('div');
  row.className = 'row';
  row.setAttribute('role', 'listitem');
  row.setAttribute('tabindex', '-1');
  row.setAttribute('data-name', r.entry.n);
  if (animDelay >= 0) { row.classList.add('anim-in'); row.style.animationDelay = animDelay + 'ms'; }

  var name = doc.createElement('span');
  name.className = 'row-name';
  name.appendChild(rowHitHtml(r.entry.n, r.nameHit));
  var desc = doc.createElement('span');
  desc.className = 'row-desc';
  desc.title = r.entry.d;
  desc.appendChild(descHtml(r.entry, r.descHits));
  var star = doc.createElement('button');
  star.type = 'button';
  star.className = 'row-star' + (ctx.favs().has(r.entry.n) ? ' starred' : '');
  star.setAttribute('aria-label', '收藏 ' + r.entry.n);
  star.innerHTML = '<i class="ic ic-star"></i>';
  star.addEventListener('click', function (ev) {
    ev.stopPropagation();
    ctx.onStar(r.entry.n, star);
  });
  row.appendChild(name);
  row.appendChild(desc);
  row.appendChild(star);
  if (r.entry.n === ctx.state().openName || r.entry.n === ctx.state().selName) setSelRow(row, true);
  return row;
}

function setSelRow(el, on) {
  el.classList.toggle('active', !!on);
}

function syncSelRow() {
  need();
  var rows = ctx.els.list.querySelectorAll('.row');
  for (var i = 0; i < rows.length; i++) {
    setSelRow(rows[i], rows[i].getAttribute('data-name') === ctx.state().selName);
  }
}

/* ── 分批渲染:rebuild 清空重建,append 只追加(禁止整表重建丢滚动位/重播动画) ── */

var BATCH = 60;

function renderList(rebuild) {
  need();
  if (rebuild) {
    var rows = ctx.els.list.querySelectorAll('.row');
    for (var i = 0; i < rows.length; i++) rows[i].remove();
    ctx.state().rendered = 0;
  }
  renderMore(rebuild);
  updateEmpty();
}

function renderMore(fresh) {
  need();
  var st = ctx.state();
  if (st.rendered >= st.results.length) return;
  var frag = global.document.createDocumentFragment();
  var end = Math.min(st.results.length, st.rendered + BATCH);
  for (var j = st.rendered; j < end; j++) {
    frag.appendChild(makeRow(st.results[j], fresh && j < 8 ? j * 14 : -1));
  }
  ctx.els.sentinel.parentNode.insertBefore(frag, ctx.els.sentinel);
  st.rendered = end;
  ctx.els.sentinel.hidden = st.rendered >= st.results.length;
}

/* ── 空态 ── */

function emptyBlock(iconClass, title, sub) {
  var doc = global.document;
  var d = doc.createElement('div');
  d.className = 'empty';
  d.innerHTML = '<i class="ic ' + iconClass + '"></i><div class="empty-t"></div><div class="empty-s"></div>';
  d.querySelector('.empty-t').textContent = title;
  d.querySelector('.empty-s').textContent = sub;
  return d;
}

function renderEmpty() {
  need();
  var st = ctx.state();
  var els = ctx.els;
  els.listEmpty.textContent = '';
  els.listEmpty.hidden = false;
  var home = !st.q && !st.letter && !st.favsOnly;
  if (home) {
    var d = emptyBlock('ic-prompt', 'Linux 命令速查', '输入命令名、拼音或描述关键词');
    var recents = ctx.recents();
    if (recents.length) {
      var sec = global.document.createElement('div');
      sec.className = 'empty-sec';
      sec.innerHTML = '<div class="empty-cap">最近查看</div>';
      var chips = global.document.createElement('div');
      chips.className = 'recent-chips';
      recents.slice(0, 20).forEach(function (n) {
        var c = global.document.createElement('button');
        c.type = 'button';
        c.className = 'chip-btn';
        c.textContent = n;
        c.addEventListener('click', function () { ctx.onOpen(n); });
        chips.appendChild(c);
      });
      sec.appendChild(chips);
      d.appendChild(sec);
    }
    els.listEmpty.appendChild(d);
    return;
  }
  if (st.favsOnly && !st.results.length && !st.q) {
    els.listEmpty.appendChild(emptyBlock('ic-star', '还没有收藏的命令', '点列表行右侧星标即可收藏'));
    return;
  }
  var q = st.q || '';
  var d3 = emptyBlock('ic-search-x', '未找到「' + q + '」', '试试拼音首字母(如 l s)或上方 A-Z 导航');
  var clr = global.document.createElement('button');
  clr.type = 'button';
  clr.className = 'chip-btn';
  clr.textContent = '清除搜索';
  clr.addEventListener('click', ctx.onClear);
  d3.appendChild(clr);
  els.listEmpty.appendChild(d3);
}

function updateEmpty() {
  need();
  var show = ctx.state().rendered === 0;
  ctx.els.listEmpty.hidden = !show;
  if (show) renderEmpty();
}

/* ── 键盘选行:↑↓ 移动,必要时补渲染;仅移动选中,不切详情 ── */

function moveSel(delta) {
  need();
  var st = ctx.state();
  if (!st.results.length) return;
  var names = st.results.map(function (r) { return r.entry.n; });
  var at = st.selName ? names.indexOf(st.selName) : -1;
  var next = at < 0 ? (delta > 0 ? 0 : names.length - 1) : Math.min(names.length - 1, Math.max(0, at + delta));
  st.selName = names[next];
  /* 有界补渲染(614 条最多 11 批,64 为双保险),依赖 results 只增不减的不变量 */
  var guard = 0;
  while (st.rendered < next + 1 && guard++ < 64) renderMore();
  syncSelRow();
  var rows = ctx.els.list.querySelectorAll('.row');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].getAttribute('data-name') === st.selName) {
      if (typeof rows[i].scrollIntoView === 'function') rows[i].scrollIntoView({ block: 'nearest' });
      break;
    }
  }
}

global.LCMD_LIST = {
  init: init,
  renderList: renderList,
  renderMore: renderMore,
  syncSelRow: syncSelRow,
  updateEmpty: updateEmpty,
  moveSel: moveSel
};
})(typeof window !== 'undefined' ? window : globalThis);