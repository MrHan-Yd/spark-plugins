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

  var CAT_LABEL = { cpu: 'CPU', gpu: 'GPU', disk: '硬盘' };
  var REFRESH_HINT = '⟳ 刷新';
  var STALE_MS = 24 * 3600 * 1000;      // 自动刷新阈值
  var RETRY_GUARD_MS = 5 * 60 * 1000;   // 自动刷新失败后的重试保护(手动刷新不受限)
  var PAGE = 300;

  var state = {
    cat: 'cpu',
    snaps: {},        // cat -> {snapshot, via, failures}
    busy: {},         // cat -> 该分类是否有进行中的联网刷新
    compare: { cpu: [], gpu: [], disk: [] },  // 对比栏:每分类最多 CMP_MAX 条 {n,s,m}
    shown: PAGE,
    query: '',
  };

  var netTriedAt = {};  // cat -> 上次自动联网尝试时间(失败保护)

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    rows: $('rows'), more: $('more'), empty: $('empty'), headMetric: $('head-metric'),
    srcBadge: $('src-badge'), statusText: $('status-text'), sourceSelect: $('source-select'),
    refresh: $('refresh'), notice: $('notice'), noticeText: $('notice-text'),
    search: $('search'), tabs: $('tabs'),
    cmpTray: $('cmp-tray'), cmpChips: $('cmp-chips'), cmpOpen: $('cmp-open'),
    cmpClear: $('cmp-clear'), cmpOverlay: $('cmp-overlay'), cmpBody: $('cmp-body'),
    cmpTitle: $('cmp-title'), cmpClose: $('cmp-close')
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

  function render() {
    var rec = state.snaps[state.cat];
    var snap = rec && rec.snapshot;
    var cat = state.cat;
    els.headMetric.textContent = snap && snap.metric ? snap.metric : '分数';
    buildSourceSelect(rec);
    updateTray();

    if (!snap || !Array.isArray(snap.items)) {
      els.rows.textContent = '';
      var busy = !!state.busy[cat];
      els.empty.textContent = busy ? '抓取中…' : '暂无数据,所有数据源均不可用';
      els.empty.hidden = false;
      els.more.hidden = true;
      els.srcBadge.textContent = '—';
      els.statusText.textContent = busy ? '抓取中…' : '暂无数据,所有数据源均不可用';
      return;
    }

    var q = state.query.trim().toLowerCase();
    var items = snap.items;
    if (q) {
      items = [];
      for (var i = 0; i < snap.items.length; i++) {
        if (snap.items[i].n.toLowerCase().indexOf(q) >= 0) items.push(snap.items[i]);
      }
    }

    var max = items.length ? items[0].s : 1;
    var pickedSet = {};
    var cmpArr = state.compare[cat];
    for (var ci = 0; ci < cmpArr.length; ci++) pickedSet[cmpArr[ci].n] = true;
    var frag = document.createDocumentFragment();
    var shown = items.slice(0, state.shown);
    for (var i = 0; i < shown.length; i++) {
      var it = shown[i];
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

      var cmpBtn = document.createElement('button');
      cmpBtn.className = 'cmp-add' + (pickedSet[it.n] ? ' on' : '');
      cmpBtn.title = pickedSet[it.n] ? '移出对比' : '加入对比';
      cmpBtn.textContent = pickedSet[it.n] ? '✓' : '＋';
      (function (item) {
        cmpBtn.addEventListener('click', function () { toggleCompare(item); });
      })(it);
      row.appendChild(cmpBtn);

      frag.appendChild(row);
    }
    els.rows.textContent = '';
    els.rows.appendChild(frag);
    els.empty.textContent = '没有匹配的型号';
    els.empty.hidden = shown.length > 0;
    els.more.hidden = shown.length >= items.length;
    if (shown.length < items.length) {
      els.more.textContent = '显示更多(还有 ' + (items.length - shown.length).toLocaleString('en-US') + ' 条)';
    }

    renderStatus(rec);
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
      if (cat === state.cat) { state.shown = PAGE; render(); }

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
        state.shown = PAGE;
        render();
        if (r.failures && r.failures.length) showNotice(r);
        else els.notice.hidden = true;
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
      if (cat === state.cat) render();
    }
  }

  /* ── 对比 ─────────────────────────────────────────────── */

  var CMP_MAX = 4;

  function itemsLookup(items, name) {
    for (var i = 0; i < items.length; i++) if (items[i].n === name) return items[i];
    return null;
  }

  function toggleCompare(item) {
    var arr = state.compare[state.cat];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].n === item.n) { arr.splice(i, 1); updateTray(); render(); return; }
    }
    if (arr.length >= CMP_MAX) {
      els.statusText.textContent = '最多同时对比 ' + CMP_MAX + ' 个型号';
      return;
    }
    arr.push({ n: item.n, s: item.s, m: item.m });
    updateTray();
    render();
  }

  function updateTray() {
    var arr = state.compare[state.cat];
    els.cmpTray.hidden = arr.length === 0;
    els.cmpChips.textContent = '';
    for (var i = 0; i < arr.length; i++) {
      (function (idx) {
        var chip = document.createElement('span');
        chip.className = 'cmp-chip';
        var t = document.createElement('span');
        t.textContent = arr[idx].n;
        t.title = arr[idx].n;
        var x = document.createElement('button');
        x.textContent = '✕';
        x.title = '移出对比';
        x.addEventListener('click', function () {
          state.compare[state.cat].splice(idx, 1);
          updateTray();
          render();
        });
        chip.appendChild(t);
        chip.appendChild(x);
        els.cmpChips.appendChild(chip);
      })(i);
    }
    els.cmpOpen.disabled = arr.length < 2;
    els.cmpOpen.textContent = arr.length >= 2 ? '对比(' + arr.length + ')' : '对比';
  }

  function openCompare() {
    var cat = state.cat;
    var arr = state.compare[cat];
    var rec = state.snaps[cat];
    var snap = rec && rec.snapshot;
    if (arr.length < 2) return;
    var items = snap && Array.isArray(snap.items) ? snap.items : null;
    var rankMap = {};
    if (items) {
      for (var i = 0; i < items.length; i++) rankMap[items[i].n] = i + 1;
    }
    var picked = arr.map(function (c) {
      return (items && itemsLookup(items, c.n)) || { n: c.n, s: c.s, m: c.m };
    });
    var best = -Infinity;
    for (var i = 0; i < picked.length; i++) best = Math.max(best, picked[i].s);

    els.cmpTitle.textContent = '对比 · ' + CAT_LABEL[cat] + (snap && snap.metric ? '(' + snap.metric + ')' : '');
    els.cmpBody.textContent = '';
    els.cmpBody.style.gridTemplateColumns = 'repeat(' + picked.length + ', minmax(0,1fr))';
    for (var i = 0; i < picked.length; i++) {
      var p = picked[i];
      var card = document.createElement('div');
      card.className = 'cmp-card' + (p.s === best ? ' best' : '');
      var rank = document.createElement('div');
      rank.className = 'rank' + (p.s === best ? ' lead' : '');
      rank.textContent = rankMap[p.n] ? '#' + rankMap[p.n] : '—';
      card.appendChild(rank);
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.n;
      card.appendChild(name);
      var score = document.createElement('div');
      score.className = 'score';
      score.textContent = fmtScore(p.s);
      card.appendChild(score);
      var bar = document.createElement('div');
      bar.className = 'bar';
      var fill = document.createElement('i');
      fill.style.width = best > 0 ? Math.max(1, Math.round(p.s / best * 100)) + '%' : '100%';
      bar.appendChild(fill);
      card.appendChild(bar);
      var rel = document.createElement('div');
      rel.className = 'rel';
      rel.textContent = p.s === best ? '最高' : '相当于最高的 ' + (best > 0 ? Math.round(p.s / best * 100) : 0) + '%';
      card.appendChild(rel);
      if (p.m) {
        var meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = p.m;
        card.appendChild(meta);
      }
      els.cmpBody.appendChild(card);
    }
    if (picked.length === 2) {
      var note = document.createElement('div');
      note.className = 'cmp-note';
      note.style.gridColumn = '1 / -1';
      var ratio = picked[0].s / picked[1].s;
      note.textContent = ratio >= 1
        ? picked[0].n + ' ≈ ' + ratio.toFixed(2) + '× ' + picked[1].n
        : picked[1].n + ' ≈ ' + (1 / ratio).toFixed(2) + '× ' + picked[0].n;
      els.cmpBody.appendChild(note);
    }
    els.cmpOverlay.hidden = false;
  }

  function closeCompare() { els.cmpOverlay.hidden = true; }

  /* ── 事件 ─────────────────────────────────────────────── */

  els.tabs.addEventListener('click', function (e) {
    var btn = e.target.closest('.tab');
    if (!btn) return;
    var cat = btn.getAttribute('data-cat');
    if (cat === state.cat) return;
    state.cat = cat;
    state.shown = PAGE;
    var tabs = els.tabs.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i] === btn);
    }
    els.search.value = '';
    state.query = '';
    setBusy(cat, !!state.busy[cat]);   // 同步忙碌视觉(切回正在抓取的分类)
    render();
    if (!state.snaps[cat]) loadCat(cat);

    // 切分类过渡:重触发榜单上浮淡入
    els.rows.classList.remove('anim-in');
    void els.rows.offsetWidth;
    els.rows.classList.add('anim-in');
  });

  var searchTimer = null;
  els.search.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.query = els.search.value;
      state.shown = PAGE;
      render();
    }, 120);
  });

  els.more.addEventListener('click', function () {
    state.shown += PAGE;
    render();
  });

  els.refresh.addEventListener('click', function () {
    if (state.busy[state.cat]) return;
    loadCat(state.cat, { force: true, preferred: els.sourceSelect.value || null });
  });

  els.sourceSelect.addEventListener('change', function () {
    if (state.busy[state.cat]) return;
    state.compare[state.cat] = [];   // 换源口径不同,清空该分类对比栏
    loadCat(state.cat, { force: true, preferred: els.sourceSelect.value || null });
  });

  els.cmpOpen.addEventListener('click', openCompare);
  els.cmpClear.addEventListener('click', function () {
    state.compare[state.cat] = [];
    updateTray();
    render();
  });
  els.cmpClose.addEventListener('click', closeCompare);
  els.cmpOverlay.addEventListener('click', function (e) {
    if (e.target === els.cmpOverlay) closeCompare();
  });
  document.addEventListener('keydown', function (e) {
    if ((e.key || '').toLowerCase() === 'escape' && !els.cmpOverlay.hidden) closeCompare();
  });

  $('notice-close').addEventListener('click', function () {
    els.notice.hidden = true;
  });

  /* ── 启动 ─────────────────────────────────────────────── */

  if (!hasNet()) {
    els.notice.hidden = false;
    els.noticeText.textContent = '未检测到宿主联网通道(spark.net.fetch),将只展示缓存与出厂快照';
  }
  loadCat('cpu');
})();