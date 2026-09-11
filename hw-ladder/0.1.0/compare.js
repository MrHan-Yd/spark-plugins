/* 硬件天梯 · 对比模块:榜单行「＋」勾选 → 托盘 → 对比 Tab 页(参数逐行对比)
 * 依赖 app.js 注入:{state, els, CAT_LABEL, fmtScore, loadCat, renderLadder, switchTab}
 */
(function (global) {
  'use strict';

  var CMP_MAX = 4;
  var deps = null;
  var cmpCatsBuilt = false;

  // 各源可对比的结构化参数(榜单排名/分数/相对最高为通用行,不在此列)
  var ATTRS = {
    'geekbench:cpu': ['核心', '频率', '单核'],
    'geekbench:gpu': ['厂商', 'Vulkan', 'Metal'],
    'passmark:cpu': ['性价比', '价格'],
    'passmark:gpu': ['性价比', '价格'],
    'passmark:disk': ['容量', '性价比', '价格'],
    'passmark:ram': ['延迟', '写入', '价格'],
    'lainbo:soc': ['厂商']
  };

  function fmtAttr(key, v) {
    if (v == null || v === '') return '—';
    if (key === '价格') return '$' + (+v).toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (typeof v === 'number') {
      if (key === '延迟') return v.toLocaleString('en-US') + ' ns';
      if (key === '写入') return v.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' GB/s';
      return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    return String(v);
  }

  /* ── 托盘(榜单页底部)────────────────────────────────── */

  function updateTray() {
    var els = deps.els;
    var state = deps.state;
    if (state.cat === 'compare') { els.cmpTray.hidden = true; return; }
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
          deps.renderLadder();
        });
        chip.appendChild(t);
        chip.appendChild(x);
        els.cmpChips.appendChild(chip);
      })(i);
    }
    els.cmpOpen.disabled = arr.length < 2;
    els.cmpOpen.textContent = arr.length >= 2 ? '去对比(' + arr.length + ')' : '去对比';
  }

  function toggleItem(item) {
    var state = deps.state;
    var arr = state.compare[state.cat];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].n === item.n) { arr.splice(i, 1); updateTray(); deps.renderLadder(); return; }
    }
    if (arr.length >= CMP_MAX) {
      deps.els.statusText.textContent = '最多同时对比 ' + CMP_MAX + ' 个型号';
      return;
    }
    arr.push({ n: item.n, s: item.s, m: item.m, a: item.a });
    updateTray();
    deps.renderLadder();
  }

  function clearCurrent() {
    var state = deps.state;
    state.compare[state.cmpCat] = [];
    deps.els.cmpSearch.value = '';
    hideSuggest();
    render();
    if (state.cat !== 'compare') deps.renderLadder();
  }

  /* ── 对比 Tab 页 ──────────────────────────────────────── */

  function onTabEnter() {
    buildCats();
    var cat = deps.state.cmpCat;
    if (!deps.state.snaps[cat]) {
      deps.loadCat(cat);   // 进度/状态由 loadCat 与页面内「数据加载中…」负责,不在状态栏写死「抓取中…」
    }
    render();
  }

  function buildCats() {
    var els = deps.els;
    if (els.cmpCats.children.length) {
      setActiveCat();
      return;
    }
    ['cpu', 'gpu', 'disk', 'ram', 'soc'].forEach(function (cat) {
      var b = document.createElement('button');
      b.className = 'cat-chip' + (cat === deps.state.cmpCat ? ' active' : '');
      b.setAttribute('data-cat', cat);
      b.textContent = deps.CAT_LABEL[cat];
      els.cmpCats.appendChild(b);
    });
    setActiveCat();
  }

  function setActiveCat() {
    var chips = deps.els.cmpCats.children;
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('active', chips[i].getAttribute('data-cat') === deps.state.cmpCat);
    }
  }

  function itemsLookup(items, name) {
    for (var i = 0; i < items.length; i++) if (items[i].n === name) return items[i];
    return null;
  }

  function currentSnapshot() {
    var rec = deps.state.snaps[deps.state.cmpCat];
    var snap = rec && rec.snapshot;
    return snap && Array.isArray(snap.items) ? snap : null;
  }

  function addItem(item) {
    var state = deps.state;
    var arr = state.compare[state.cmpCat];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].n === item.n) return;   // 已在对比栏
    }
    if (arr.length >= CMP_MAX) {
      deps.els.statusText.textContent = '最多同时对比 ' + CMP_MAX + ' 个型号';
      return;
    }
    arr.push({ n: item.n, s: item.s, m: item.m, a: item.a });
    deps.els.cmpSearch.value = '';
    hideSuggest();
    render();
  }

  function hideSuggest() { deps.els.cmpSuggest.hidden = true; }

  function renderSuggest() {
    var els = deps.els;
    var snap = currentSnapshot();
    var q = els.cmpSearch.value.trim().toLowerCase();
    var arr = deps.state.compare[deps.state.cmpCat];
    els.cmpSuggest.textContent = '';
    if (!snap || !q) { hideSuggest(); return; }
    var pickedNames = {};
    for (var i = 0; i < arr.length; i++) pickedNames[arr[i].n] = true;
    var shown = 0;
    for (var i = 0; i < snap.items.length && shown < 12; i++) {
      var it = snap.items[i];
      if (it.n.toLowerCase().indexOf(q) < 0 || pickedNames[it.n]) continue;
      (function (item) {
        var div = document.createElement('div');
        div.className = 'sug-item';
        var nm = document.createElement('span');
        nm.textContent = item.n;
        var sc = document.createElement('span');
        sc.className = 'sug-score';
        sc.textContent = item.s.toLocaleString('en-US');
        div.appendChild(nm);
        div.appendChild(sc);
        div.addEventListener('mousedown', function (e) { e.preventDefault(); addItem(item); });
        els.cmpSuggest.appendChild(div);
        shown++;
      })(it);
    }
    els.cmpSuggest.hidden = shown === 0;
  }

  /* 对比 Tab 主渲染 */
  function render() {
    var els = deps.els;
    var cat = deps.state.cmpCat;
    var snap = currentSnapshot();
    var arr = deps.state.compare[cat];
    buildCats();
    setActiveCat();

    els.cmpMetric.textContent = snap
      ? deps.CAT_LABEL[cat] + ' · ' + snap.metric
      : deps.CAT_LABEL[cat] + ' · 数据加载中…';

    // 已选 chips
    els.cmpSelChips.textContent = '';
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
          deps.state.compare[cat].splice(idx, 1);
          render();
          if (deps.state.cat !== 'compare') deps.renderLadder();
        });
        chip.appendChild(t);
        chip.appendChild(x);
        els.cmpSelChips.appendChild(chip);
      })(i);
    }

    els.cmpTable.textContent = '';
    els.cmpEmpty.hidden = false;
    if (!snap) {
      els.cmpEmpty.textContent = '数据加载中…(首次抓取硬盘榜较慢)';
      return;
    }
    if (arr.length < 2) {
      els.cmpEmpty.textContent = arr.length === 0
        ? '在上方搜索添加型号,或回到榜单页点行内「＋」勾选,选 2-4 个即可开始对比'
        : '再添加 1 个型号即可开始对比(最多 ' + CMP_MAX + ' 个)';
      return;
    }
    els.cmpEmpty.hidden = true;
    renderTable(cat, snap, arr);
  }

  function renderTable(cat, snap, arr) {
    var els = deps.els;
    var rankMap = {};
    for (var i = 0; i < snap.items.length; i++) rankMap[snap.items[i].n] = i + 1;
    var picked = arr.map(function (c) {
      return (itemsLookup(snap.items, c.n)) || { n: c.n, s: c.s, m: c.m, a: c.a };
    });
    var best = -Infinity;
    for (var i = 0; i < picked.length; i++) best = Math.max(best, picked[i].s);
    var attrs = ATTRS[snap.source + ':' + cat] || [];

    // 每行写入同一列模板,保证参数列/各型号列在所有行间垂直对齐
    var tpl = '120px repeat(' + picked.length + ', minmax(0,1fr))';

    var table = els.cmpTable;
    table.style.gridTemplateColumns = '';

    function row(label, values, opts) {
      opts = opts || {};
      var d = document.createElement('div');
      d.className = 'cmp-row' + (opts.head ? ' cmp-head-row' : '') + (opts.main ? ' cmp-main-row' : '');
      d.style.gridTemplateColumns = tpl;
      var lab = document.createElement('div');
      lab.className = 'cmp-attr';
      lab.textContent = label;
      d.appendChild(lab);
      for (var i = 0; i < values.length; i++) {
        (function (v, idx) {
          var c = document.createElement('div');
          c.className = 'cmp-val' + (opts.best === idx ? ' best' : '');
          if (typeof v === 'object' && v.nodeType) {
            c.appendChild(v);
          } else {
            c.textContent = v;
          }
          d.appendChild(c);
        })(values[i], i);
      }
      table.appendChild(d);
      return d;
    }

    // 表头:参数 + 型号列(可移除)
    var head = document.createElement('div');
    head.className = 'cmp-row cmp-head-row';
    head.style.gridTemplateColumns = tpl;
    var hLab = document.createElement('div');
    hLab.className = 'cmp-attr';
    hLab.textContent = '参数';
    head.appendChild(hLab);
    for (var i = 0; i < picked.length; i++) {
      (function (p, idx) {
        var c = document.createElement('div');
        c.className = 'cmp-val cmp-item-head';
        var nm = document.createElement('span');
        nm.textContent = p.n;
        var x = document.createElement('button');
        x.className = 'ghost-btn';
        x.textContent = '✕';
        x.title = '移出对比';
        x.addEventListener('click', function () {
          deps.state.compare[cat].splice(idx, 1);
          render();
        });
        c.appendChild(nm);
        c.appendChild(x);
        head.appendChild(c);
      })(picked[i], i);
    }
    table.appendChild(head);

    var bestIdx = -1;
    for (var i = 0; i < picked.length; i++) if (picked[i].s === best) bestIdx = i;

    row('榜单排名', picked.map(function (p) {
      return rankMap[p.n] ? '#' + rankMap[p.n] : '—';
    }));
    row(snap.metric || '分数', picked.map(function (p) {
      return p.s.toLocaleString('en-US');
    }), { best: bestIdx, main: true });
    for (var i = 0; i < attrs.length; i++) {
      (function (key) {
        row(key, picked.map(function (p) {
          return (p.a && p.a[key] != null) ? fmtAttr(key, p.a[key]) : '—';
        }), { best: -1 });
      })(attrs[i]);
    }
    row('相对最高', picked.map(function (p) {
      var pct = best > 0 ? Math.round(p.s / best * 100) : 0;
      var isBest = p.s === best;
      var wrap = document.createElement('div');
      wrap.className = 'cmp-rel' + (isBest ? ' best' : '');
      var txt = document.createElement('span');
      txt.textContent = isBest ? '最高' : pct + '%';
      var track = document.createElement('div');
      track.className = 'cmp-rel-track';
      var fill = document.createElement('div');
      fill.className = 'cmp-rel-fill';
      fill.style.width = Math.max(2, pct) + '%';
      track.appendChild(fill);
      wrap.appendChild(txt);
      wrap.appendChild(track);
      return wrap;
    }), { best: bestIdx });

    if (picked.length === 2) {
      var note = document.createElement('div');
      note.className = 'cmp-note';
      var ratio = picked[0].s / picked[1].s;
      note.textContent = ratio >= 1
        ? picked[0].n + ' ≈ ' + ratio.toFixed(2) + '× ' + picked[1].n
        : picked[1].n + ' ≈ ' + (1 / ratio).toFixed(2) + '× ' + picked[0].n;
      table.appendChild(note);
    }
  }

  /* ── 事件接线 ─────────────────────────────────────────── */

  var sugTimer = null;

  function wireEvents() {
    var els = deps.els;
    els.cmpOpen.addEventListener('click', function () {
      if (deps.state.compare[deps.state.cat].length >= 2) deps.switchTab('compare');
    });
    els.cmpClear.addEventListener('click', clearCurrent);
    els.cmpCats.addEventListener('click', function (e) {
      var b = e.target.closest('.cat-chip');
      if (!b) return;
      var cat = b.getAttribute('data-cat');
      if (cat === deps.state.cmpCat) return;
      deps.state.cmpCat = cat;
      hideSuggest();
      els.cmpSearch.value = '';
      onTabEnter();
    });
    els.cmpSearch.addEventListener('input', function () {
      clearTimeout(sugTimer);
      sugTimer = setTimeout(renderSuggest, 120);
    });
    els.cmpSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var first = els.cmpSuggest.children[0];
        if (first && !els.cmpSuggest.hidden) first.dispatchEvent && first.dispatchEvent(new Event('mousedown'));
        else renderSuggest();
      }
      if (e.key === 'Escape') hideSuggest();
    });
    els.cmpSearch.addEventListener('blur', function () { setTimeout(hideSuggest, 150); });
  }

  global.HWL_COMPARE = {
    init: function (d) { deps = d; wireEvents(); },
    onTabEnter: onTabEnter,
    render: render,
    toggleItem: toggleItem,
    updateTray: updateTray,
    fmtAttr: fmtAttr,
    clearCat: function (cat) { deps.state.compare[cat] = []; }
  };
})(typeof window !== 'undefined' ? window : globalThis);