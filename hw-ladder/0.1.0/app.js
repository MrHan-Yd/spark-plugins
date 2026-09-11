/* 硬件天梯 · 页面接线:主题/榜单渲染/搜索/双源刷新 */

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
    e.preventDefault(); return;
  }
  if (!editing && (e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'r') {
    e.preventDefault();
  }
}, true);

(function () {
  'use strict';

  /* ── 主题 ─────────────────────────────────────────────── */

  var store = (function () {
    if (window.spark && window.spark.db) {
      return {
        get: function (k) { return window.spark.db.get('hw_' + k); },
        set: function (k, v) { return window.spark.db.set('hw_' + k, v); }
      };
    }
    return {
      get: function (k) {
        try { return JSON.parse(localStorage.getItem('hwl_' + k)); } catch (e) { return null; }
      },
      set: function (k, v) {
        try { localStorage.setItem('hwl_' + k, JSON.stringify(v)); } catch (e) { /* 忽略 */ }
        return Promise.resolve();
      }
    };
  })();

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    document.getElementById('theme-btn').textContent = t === 'dark' ? '☀️' : '🌙';
  }

  var theme = null;
  try { theme = JSON.parse(localStorage.getItem('hwl_theme')); } catch (e) { /* 主题用 localStorage,host db 也可 */ }
  applyTheme(theme || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

  document.getElementById('theme-btn').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    var next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('hwl_theme', JSON.stringify(next)); } catch (e) { /* 忽略 */ }
  });

  /* ── 状态 ─────────────────────────────────────────────── */

  var CAT_LABEL = { cpu: 'CPU', gpu: 'GPU', disk: '硬盘', ram: '内存', soc: '手机 SoC' };
  var REFRESH_HINT = '⟳ 刷新';
  var STALE_MS = 24 * 3600 * 1000;      // 自动刷新阈值
  var RETRY_GUARD_MS = 5 * 60 * 1000;   // 自动刷新失败后的重试保护(手动刷新不受限)
  var BATCH = 60;                       // 滚动加载:首批/每批渲染行数

  var state = {
    cat: 'cpu',
    snaps: {},        // cat -> {snapshot, via, failures}
    busy: {},         // cat -> 该分类是否有进行中的联网刷新
    compare: { cpu: [], gpu: [], disk: [], ram: [], soc: [] },  // 对比栏:每分类最多 4 条 {n,s,m,a}
    cmpCat: 'cpu',    // 对比 Tab 页内的分类
    detail: null,     // 详情弹层当前条目 {item}
    shown: BATCH,     // 已渲染到的目标行数(滚动加载递增)
    rendered: 0,      // 当前 DOM 里的行数(续渲染从此续起)
    filteredCount: 0, // 当前过滤后的总条数
    memShown: {},     // cat -> 离开时已加载行数(切回恢复,不从头再来)
    memScroll: {},    // cat -> 离开时榜单滚动位置
    query: '',
  };

  var netTriedAt = {};  // cat -> 上次自动联网尝试时间(失败保护)

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    rows: $('rows'), sentinel: $('sentinel'), empty: $('empty'), headMetric: $('head-metric'),
    srcBadge: $('src-badge'), statusText: $('status-text'), sourceSelect: $('source-select'),
    refresh: $('refresh'), notice: $('notice'), noticeText: $('notice-text'),
    search: $('search'), tabs: $('tabs'),
    cmpTray: $('cmp-tray'), cmpChips: $('cmp-chips'), cmpOpen: $('cmp-open'), cmpClear: $('cmp-clear'),
    viewLadder: $('view-ladder'), viewCompare: $('view-compare'),
    cmpCats: $('cmp-cats'), cmpMetric: $('cmp-metric'), cmpSearch: $('cmp-search'),
    cmpSuggest: $('cmp-suggest'), cmpSelChips: $('cmp-selchips'),
    cmpTable: $('cmp-table'), cmpEmpty: $('cmp-empty'),
    detailMask: $('detail-mask'), detailName: $('detail-name'), detailMeta: $('detail-meta'),
    detailMetric: $('detail-metric'), detailScore: $('detail-score'), detailRank: $('detail-rank'),
    detailParams: $('detail-params'), detailSrc: $('detail-src'), detailCmp: $('detail-cmp')
  };

  function hasNet() {
    return !!(window.spark && window.spark.net && typeof window.spark.net.fetch === 'function');
  }

  /* ── 渲染 ─────────────────────────────────────────────── */

  function fmtScore(n) { return n.toLocaleString('en-US'); }

  function fmtTime(iso) {
    var t = Date.parse(iso);
    if (!t) return iso || '';
    var d = Date.now() - t;
    if (d < 60e3) return '刚刚';
    if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
    return new Date(t).toISOString().slice(0, 10);
  }

  function failText(f) {
    var label = f.label || window.HWL_SOURCES.SOURCE_LABEL[f.source] || f.source || '联网';
    return label + ':' + f.error;
  }

  // rebuild !== false:清空重建(换分类/换快照/换查询/对比勾选变化);
  // rebuild === false:滚动加载续渲染,只追加 [rendered, target) 区间的新行
  function renderLadder(rebuild) {
    var rec = state.snaps[state.cat];
    var snap = rec && rec.snapshot;
    var cat = state.cat;
    els.headMetric.textContent = snap && snap.metric ? snap.metric : '分数';
    buildSourceSelect(rec);
    window.HWL_COMPARE.updateTray();

    if (!snap || !Array.isArray(snap.items)) {
      els.rows.textContent = '';
      state.rendered = 0;
      state.filteredCount = 0;
      var busy = !!state.busy[cat];
      els.empty.textContent = busy ? '抓取中…' : '暂无数据,所有数据源均不可用';
      els.empty.hidden = false;
      els.sentinel.hidden = true;
      els.srcBadge.textContent = '—';
      els.statusText.textContent = busy ? '抓取中…' : '暂无数据,所有数据源均不可用';
      return;
    }

    var q = state.query.trim().toLowerCase();
    var items = snap.items;
    var rankMap = {};   // 全榜名次(按快照顺序),搜索过滤后名次不变
    for (var ri = 0; ri < snap.items.length; ri++) rankMap[snap.items[ri].n] = ri + 1;
    if (q) {
      items = [];
      for (var fi = 0; fi < snap.items.length; fi++) {
        if (snap.items[fi].n.toLowerCase().indexOf(q) >= 0) items.push(snap.items[fi]);
      }
    }
    state.filteredCount = items.length;

    if (rebuild !== false) {
      els.rows.textContent = '';
      state.rendered = 0;
    }

    var max = items.length ? items[0].s : 1;
    var pickedSet = {};
    var cmpArr = state.compare[cat];
    for (var ci = 0; ci < cmpArr.length; ci++) pickedSet[cmpArr[ci].n] = true;
    var target = Math.min(state.shown, items.length);
    var frag = document.createDocumentFragment();
    for (var i = state.rendered; i < target; i++) {
      var it = items[i];
      var row = document.createElement('div');
      row.className = 'row' + (i < 3 && !q ? ' r' + (i + 1) : '') + (pickedSet[it.n] ? ' cmp-on' : '');

      var rank = document.createElement('div');
      rank.className = 'rank';
      rank.textContent = String(i + 1);
      row.appendChild(rank);

      var main = document.createElement('div');
      main.className = 'cell-main';
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = it.n;
      main.appendChild(name);
      if (it.m) {
        var meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = it.m;
        main.appendChild(meta);
      }
      var bar = document.createElement('div');
      bar.className = 'bar';
      var fill = document.createElement('i');
      fill.style.width = Math.max(1, Math.round(it.s / max * 100)) + '%';
      bar.appendChild(fill);
      main.appendChild(bar);
      row.appendChild(main);

      var score = document.createElement('div');
      score.className = 'score';
      score.textContent = fmtScore(it.s);
      row.appendChild(score);

      (function (item) {
        row.addEventListener('click', function () { openDetail(item.n); });
      })(it);

      var cmpBtn = document.createElement('button');
      cmpBtn.className = 'cmp-add' + (pickedSet[it.n] ? ' on' : '');
      cmpBtn.title = pickedSet[it.n] ? '移出对比' : '加入对比';
      cmpBtn.textContent = pickedSet[it.n] ? '✓' : '＋';
      (function (item) {
        cmpBtn.addEventListener('click', function (e) {
          e.stopPropagation();   // 加对比不触发整行详情
          window.HWL_COMPARE.toggleItem(item);
        });
      })(it);
      row.appendChild(cmpBtn);

      frag.appendChild(row);
    }
    state.rendered = target;
    els.rows.appendChild(frag);
    els.empty.textContent = '没有匹配的型号';
    els.empty.hidden = target > 0;
    els.sentinel.hidden = target >= items.length;

    renderStatus(rec);
  }

  // 滚动加载:哨兵进入视口(含首屏未填满)时续渲染一批
  function loadMore() {
    if (state.cat === 'compare') return;
    if (state.rendered >= state.filteredCount) return;
    state.shown += BATCH;
    renderLadder(false);
  }

  function buildSourceSelect(rec) {
    var chain = window.HWL_SOURCES.CHAIN[state.cat] || [];
    var sel = els.sourceSelect;
    sel.textContent = '';
    var optAuto = document.createElement('option');
    optAuto.value = '';
    optAuto.textContent = '自动(主源优先)';
    sel.appendChild(optAuto);
    for (var i = 0; i < chain.length; i++) {
      var opt = document.createElement('option');
      opt.value = chain[i];
      opt.textContent = window.HWL_SOURCES.SOURCE_LABEL[chain[i]] || chain[i];
      sel.appendChild(opt);
    }
    sel.disabled = !!state.busy[state.cat];
    sel.value = rec && rec.snapshot && rec.snapshot.source && rec.via !== 'builtin' ? rec.snapshot.source : '';
  }

  function renderStatus(rec) {
    var snap = rec.snapshot;
    var label = window.HWL_SOURCES.SOURCE_LABEL[snap.source] || snap.source;
    els.srcBadge.textContent = label;
    var bits = [snap.metric || ''];
    bits.push('共 ' + snap.count.toLocaleString('en-US') + ' 条');
    bits.push('抓取于 ' + fmtTime(snap.fetched_at));
    var via = { network: '在线', cache: '缓存', builtin: '出厂快照' }[rec.via] || rec.via;
    if (snap.partial) via += ' · 部分';
    bits.push(via);
    els.statusText.textContent = bits.filter(Boolean).join(' · ');
  }

  function showNotice(rec) {
    var msgs = [];
    if (rec && rec.failures && rec.failures.length) {
      for (var i = 0; i < rec.failures.length; i++) {
        msgs.push(failText(rec.failures[i]));
      }
    }
    if (rec && rec.via === 'cache') msgs.unshift('当前展示的是离线缓存,可点「刷新」重试联网');
    if (rec && rec.via === 'builtin') msgs.unshift('当前展示的是出厂快照,可点「刷新」重试联网');
    if (!msgs.length) { els.notice.hidden = true; return; }
    els.noticeText.textContent = msgs.join(';');
    els.notice.hidden = false;
  }

  /* ── 详情弹层 ─────────────────────────────────────────── */

  function syncDetailCmp(item) {
    var arr = state.compare[state.cat];
    var picked = false;
    for (var i = 0; i < arr.length; i++) if (arr[i].n === item.n) { picked = true; break; }
    els.detailCmp.textContent = picked ? '移出对比' : '加入对比';
    els.detailCmp.title = picked ? '从对比栏移除' : '加入底部对比栏';
  }

  function openDetail(name) {
    var rec = state.snaps[state.cat];
    var snap = rec && rec.snapshot;
    var item = null, rank = null;
    if (snap && Array.isArray(snap.items)) {
      for (var i = 0; i < snap.items.length; i++) {
        if (snap.items[i].n === name) { item = snap.items[i]; rank = i + 1; break; }
      }
    }
    if (!item) return;
    state.detail = { item: item };

    els.detailName.textContent = item.n;
    els.detailMeta.textContent = item.m || '';
    els.detailMeta.hidden = !item.m;
    els.detailMetric.textContent = snap && snap.metric ? snap.metric : '分数';
    els.detailScore.textContent = fmtScore(item.s);
    els.detailRank.textContent = rank ? '#' + rank : '未上榜';
    els.detailRank.hidden = !rank;

    // 参数逐行:计算行(相对榜首)+ 解析器带出的结构化属性(排名已在分数行展示,不重复)
    els.detailParams.textContent = '';
    var rows = [];
    var top = (snap && Array.isArray(snap.items) && snap.items.length) ? snap.items[0].s : 0;
    rows.push(['相对榜首', top ? Math.round(item.s / top * 100) + '%' : '—']);
    var attrs = item.a || {};
    var attrKeys = Object.keys(attrs).filter(function (k) { return k !== '排名'; });
    for (var k = 0; k < attrKeys.length; k++) {
      rows.push([attrKeys[k], window.HWL_COMPARE.fmtAttr(attrKeys[k], attrs[attrKeys[k]])]);
    }
    for (var r = 0; r < rows.length; r++) {
      (function (pair) {
        var prow = document.createElement('div');
        prow.className = 'detail-prow';
        var pk = document.createElement('div');
        pk.className = 'detail-pkey';
        pk.textContent = pair[0];
        var pv = document.createElement('div');
        pv.className = 'detail-pval';
        pv.textContent = pair[1];
        prow.appendChild(pk);
        prow.appendChild(pv);
        els.detailParams.appendChild(prow);
      })(rows[r]);
    }

    els.detailSrc.textContent = snap
      ? (window.HWL_SOURCES.SOURCE_LABEL[snap.source] || snap.source) + ' · 抓取于 ' + fmtTime(snap.fetched_at)
      : '';
    syncDetailCmp(item);
    els.detailMask.hidden = false;
  }

  function closeDetail() {
    els.detailMask.hidden = true;
    state.detail = null;
  }

  /* ── 取数编排 ─────────────────────────────────────────── */

  function isStale(snap) {
    var t = Date.parse(snap && snap.fetched_at);
    return !t || (Date.now() - t) > STALE_MS;
  }

  function setBusy(cat, busy, text) {
    state.busy[cat] = busy;
    if (cat !== state.cat) return;
    els.refresh.classList.toggle('busy', busy);
    els.refresh.textContent = busy ? '⟳ 刷新中…' : REFRESH_HINT;
    els.sourceSelect.disabled = busy;
    if (text) els.statusText.textContent = text;
  }

  async function loadCat(cat, opts) {
    opts = opts || {};
    if (state.busy[cat] && !opts.force) return;
    setBusy(cat, true);

    try {
      // 1) 快速渲染:缓存 / 出厂快照(不联网)
      var fast = null;
      try {
        fast = await window.HWL_SOURCES.getSnapshot(cat, { store: store, allowNetwork: false, preferredSource: opts.preferred });
      } catch (e) {
        fast = { snapshot: null, via: 'none', failures: [{ label: '缓存', error: '读取失败:' + ((e && e.message) || e) }] };
      }
      if (fast.snapshot) state.snaps[cat] = fast;
      if (cat === state.cat) { state.shown = BATCH; renderView(); }
      else if (state.cat === 'compare' && cat === state.cmpCat) renderView();

      // 2) 决定是否联网
      var need = opts.force || !fast.snapshot || fast.via === 'builtin' ||
        (fast.snapshot && isStale(fast.snapshot));
      var now = Date.now();
      if (!opts.force && netTriedAt[cat] && (now - netTriedAt[cat]) < RETRY_GUARD_MS) need = false;
      if (need && !hasNet()) {
        netTriedAt[cat] = now;
        if (cat === state.cat) {
          var offlineRec = state.snaps[cat] || { via: 'none', failures: [] };
          var viaName = { network: '在线', cache: '缓存', builtin: '出厂快照' }[offlineRec.via] || '兜底';
          showNotice({
            via: offlineRec.via,
            failures: (offlineRec.failures || []).concat([
              { label: '离线提示', error: '宿主无联网通道(net.fetch 不可用),当前展示' + viaName + '数据' }
            ])
          });
        }
        return;
      }
      if (!need) return;

      netTriedAt[cat] = now;
      if (cat === state.cat) {
        els.statusText.textContent = cat === 'disk' ? '硬盘榜抓取中…' : '抓取中…';
      }
      var r = await window.HWL_SOURCES.getSnapshot(cat, {
        store: store,
        allowNetwork: true,
        preferredSource: opts.preferred || null,
        onProgress: function (p) {
          if (p && p.total > 1 && cat === state.cat) {
            els.statusText.textContent = '抓取中:第 ' + p.page + '/' + p.total + ' 页…';
          }
        }
      });
      if (r.snapshot) state.snaps[cat] = r;
      else r.via = (state.snaps[cat] || {}).via || 'none';
      if (cat === state.cat) {
        state.shown = BATCH;
        renderView();
        if (r.failures && r.failures.length) showNotice(r);
        else els.notice.hidden = true;
      } else if (state.cat === 'compare' && cat === state.cmpCat) {
        renderView();
      }
    } catch (e) {
      var msg = (e && e.message) || String(e);
      if (cat === state.cat) {
        els.statusText.textContent = '刷新失败:' + msg;
        showNotice({
          via: 'none',
          failures: [{ label: '联网', error: '刷新失败:' + msg }].concat((state.snaps[cat] || {}).failures || [])
        });
      }
    } finally {
      setBusy(cat, false);
      if (cat === state.cat) renderView();
      else if (state.cat === 'compare' && cat === state.cmpCat) renderView();
    }
  }

  /* ── 视图分发与 Tab 切换 ──────────────────────────────── */

  function renderView() {
    if (state.cat === 'compare') window.HWL_COMPARE.render();
    else renderLadder();
  }

  function animView(el) {
    el.classList.remove('anim-in');
    void el.offsetWidth;
    el.classList.add('anim-in');
  }

  function switchTab(cat) {
    if (cat === state.cat && cat !== 'compare') return;
    var oldCat = state.cat;
    if (oldCat !== 'compare') {
      // 离开榜单分类前记住渲染进度与滚动位置,切回不从头再来
      state.memShown[oldCat] = Math.max(state.memShown[oldCat] || BATCH, state.shown);
      state.memScroll[oldCat] = els.viewLadder.scrollTop;
    }
    state.cat = cat;
    var tabs = els.tabs.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-cat') === cat);
    }
    if (cat === 'compare') {
      els.viewLadder.hidden = true;
      els.viewCompare.hidden = false;
      els.refresh.disabled = true;        // 对比页无榜单可刷,避免点了没反应
      els.sourceSelect.disabled = true;
      els.search.hidden = true;           // 榜单搜索在对比页无用,只留对比页自己的搜索
      window.HWL_COMPARE.updateTray();    // 榜单页的底部托盘不带入对比页
      window.HWL_COMPARE.onTabEnter();
      els.statusText.textContent = '对比模式';
      animView(els.viewCompare);
    } else {
      els.viewCompare.hidden = true;
      els.viewLadder.hidden = false;
      els.refresh.disabled = false;
      els.search.hidden = false;
      els.search.value = '';
      state.query = '';
      state.shown = state.memShown[cat] || BATCH;   // 切回恢复之前的加载进度
      setBusy(cat, !!state.busy[cat]);   // 同步忙碌视觉(切回正在抓取的分类)
      renderView();
      els.viewLadder.scrollTop = state.memScroll[cat] || 0;   // 恢复滚动位置
      if (!state.snaps[cat]) loadCat(cat);
      animView(els.rows);
    }
  }

  /* ── 事件 ─────────────────────────────────────────────── */

  els.tabs.addEventListener('click', function (e) {
    var btn = e.target.closest('.tab');
    if (!btn) return;
    switchTab(btn.getAttribute('data-cat'));
  });

  var searchTimer = null;
  els.search.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.query = els.search.value;
      state.shown = BATCH;
      renderLadder();
    }, 120);
  });

  // 滚动加载:哨兵进入视口(含首屏未填满)就续渲染一批;rootMargin 提前 400px 预加载
  if (typeof IntersectionObserver === 'function') {
    var scrollIo = new IntersectionObserver(function (entries) {
      if (entries[0] && entries[0].isIntersecting) loadMore();
    }, { root: els.viewLadder, rootMargin: '400px' });
    scrollIo.observe(els.sentinel);
  }

  els.refresh.addEventListener('click', function () {
    if (state.busy[state.cat]) return;
    loadCat(state.cat, { force: true, preferred: els.sourceSelect.value || null });
  });

  els.sourceSelect.addEventListener('change', function () {
    if (state.busy[state.cat]) return;
    window.HWL_COMPARE.clearCat(state.cat);   // 换源口径不同,清空该分类对比栏
    window.HWL_COMPARE.updateTray();
    loadCat(state.cat, { force: true, preferred: els.sourceSelect.value || null });
  });

  $('notice-close').addEventListener('click', function () {
    els.notice.hidden = true;
  });

  els.detailMask.addEventListener('click', function (e) {
    if (e.target === els.detailMask) closeDetail();
  });

  $('detail-close').addEventListener('click', closeDetail);

  els.detailCmp.addEventListener('click', function () {
    if (!state.detail) return;
    window.HWL_COMPARE.toggleItem(state.detail.item);
    syncDetailCmp(state.detail.item);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !els.detailMask.hidden) closeDetail();
  });

  /* ── 启动 ─────────────────────────────────────────────── */

  window.HWL_COMPARE.init({
    state: state, els: els, CAT_LABEL: CAT_LABEL, fmtScore: fmtScore,
    loadCat: loadCat, renderLadder: renderLadder, switchTab: switchTab
  });

  if (!hasNet()) {
    els.notice.hidden = false;
    els.noticeText.textContent = '未检测到宿主联网通道(spark.net.fetch),将只展示缓存与出厂快照';
  }
  loadCat('cpu');
})();