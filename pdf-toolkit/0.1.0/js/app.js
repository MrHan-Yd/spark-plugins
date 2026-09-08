/* PDF 工具箱 — UI 外壳
 *
 * 职责：工具路由、拖放与文件列表、分段控件、进度/状态条、
 *       结果渲染与保存（优先 showSaveFilePicker 系统另存为，回退浏览器下载）、ZIP 打包、启动装配。
 * 工具的具体处理逻辑在 tools.js（window.Tools）；合并工具的可视化编辑器在 merge.js（window.MergeTool）。
 * 依赖顺序：vendor 库 → engine.js → convert.js → app.js → tools.js → merge.js
 */
(function (global) {
  'use strict';

  var E = global.PdfEngine;

  /* ─────────── 基础工具 ─────────── */

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function stripPdfExt(name) { return (name || '').replace(/\.pdf$/i, ''); }

  /** 让出主线程片刻，保证进度文本可见 */
  function yieldFrame() {
    return new Promise(function (r) { setTimeout(r, 16); });
  }

  /* ─────────── spark.* 封装（全部可降级） ─────────── */

  function notify(title, body) {
    try {
      if (global.spark && global.spark.notify) global.spark.notify.show({ title: title, body: body });
    } catch (e) { /* 未授权静默 */ }
  }

  async function loadSetting(key) {
    try {
      if (global.spark && global.spark.db) return await global.spark.db.get('pdftk_' + key);
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function saveSetting(key, value) {
    try {
      if (global.spark && global.spark.db) global.spark.db.set('pdftk_' + key, value);
    } catch (e) { /* 忽略 */ }
  }

  /* ─────────── 状态条 / 进度 ─────────── */

  var statusTimer = null;

  function setStatus(text, type) {
    var bar = $('#statusbar');
    if (!bar) return;
    if (!text) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.className = 'statusbar' + (type ? ' ' + type : '');
    $('#statusbar-text').textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    if (type === 'ok' || type === 'err') {
      statusTimer = setTimeout(function () { bar.hidden = true; }, 6000);
    }
  }

  function progShow(key, text) {
    var el = $('#prog-' + key);
    if (!el) return;
    el.hidden = false;
    el.querySelector('.bar i').style.width = '0%';
    el.querySelector('.prog-text').textContent = text || '';
  }

  function progUpdate(key, text, pct) {
    var el = $('#prog-' + key);
    if (!el) return;
    el.hidden = false;
    if (pct != null) el.querySelector('.bar i').style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (text != null) el.querySelector('.prog-text').textContent = text;
  }

  function progHide(key) {
    var el = $('#prog-' + key);
    if (el) el.hidden = true;
  }

  /* ─────────── 文件会话 ─────────── */

  var sessions = {};

  function session(key) {
    if (!sessions[key]) sessions[key] = { files: [] };
    return sessions[key];
  }

  function renderFiles(key) {
    var box = $('#files-' + key);
    if (!box) return;
    var s = session(key);
    box.textContent = '';
    s.files.forEach(function (f, i) {
      var row = document.createElement('div');
      row.className = 'file-row';

      var ico = document.createElement('span');
      ico.className = 'f-ico';
      ico.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
      row.appendChild(ico);

      var name = document.createElement('span');
      name.className = 'f-name';
      name.textContent = f.name;
      name.title = f.name;
      row.appendChild(name);

      var size = document.createElement('span');
      size.className = 'f-size';
      size.textContent = E.formatBytes(f.size);
      row.appendChild(size);

      var st = document.createElement('span');
      st.className = 'f-state' + (f.state === 'ok' ? ' ok' : f.state === 'busy' ? ' busy' : f.state === 'err' ? ' err' : '');
      st.textContent = f.stateText || '待处理';
      row.appendChild(st);

      var x = document.createElement('button');
      x.className = 'f-x';
      x.type = 'button';
      x.title = '移除';
      x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      x.addEventListener('click', function () {
        session(key).files.splice(i, 1);
        renderFiles(key);
        if (window.Tools && window.Tools.onFilesRemoved) window.Tools.onFilesRemoved(key);
      });
      row.appendChild(x);

      box.appendChild(row);
    });
  }

  function setFileState(key, idx, state, stateText) {
    var f = session(key).files[idx];
    if (!f) return;
    f.state = state;
    f.stateText = stateText;
    renderFiles(key);
  }

  /** 处理中锁住文件行的移除按钮：运行中增删会让按索引定位的状态写到错误的行 */
  function setFilesLocked(key, locked) {
    $$('#files-' + key + ' .f-x').forEach(function (b) { b.disabled = !!locked; });
  }

  async function addFiles(key, fileList, accept) {
    var s = session(key);
    var skipped = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var lower = (f.name || '').toLowerCase();
      var ok = accept.indexOf('pdf') >= 0 && /\.pdf$/.test(lower);
      if (!ok && accept.indexOf('image') >= 0) {
        ok = /\.(jpe?g|png)$/.test(lower) || /^image\/(jpe?g|png)$/.test(f.type || '');
      }
      if (!ok) { skipped.push(f.name); continue; }
      var data;
      try {
        data = new Uint8Array(await f.arrayBuffer());
      } catch (e) {
        // 拖入名为 *.pdf 的目录等读取失败场景，不能静默无提示
        skipped.push(f.name + '（读取失败' + (e && e.message ? '：' + e.message : '') + '）');
        continue;
      }
      s.files.push({ name: f.name, size: data.byteLength, data: data, state: 'idle' });
    }
    renderFiles(key);
    if (skipped.length) {
      setStatus('已跳过不支持的文件：' + skipped.slice(0, 3).join('、') + (skipped.length > 3 ? ' 等 ' + skipped.length + ' 个' : ''), 'err');
    }
    return skipped;
  }

  function wireDropzone(key, accept, onAdded) {
    var zone = $('#dz-' + key);
    var input = $('#file-' + key);
    if (!zone || !input) return;
    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('drag'); });
    });
    zone.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) {
        addFiles(key, Array.prototype.slice.call(files), accept).then(function () {
          if (onAdded) onAdded();
        }).catch(function (e) {
          setStatus('添加文件失败：' + (e && e.message ? e.message : e), 'err');
        });
      }
    });
    input.addEventListener('change', function () {
      if (input.files && input.files.length) {
        addFiles(key, Array.prototype.slice.call(input.files), accept).then(function () {
          if (onAdded) onAdded();
        }).catch(function (e) {
          setStatus('添加文件失败：' + (e && e.message ? e.message : e), 'err');
        });
      }
      input.value = '';
    });
  }

  /* ─────────── 结果渲染与保存 ─────────── */

  var resStore = {};
  var resUrls = {}; // key -> 结果项的 ObjectURL 清单（结果覆盖/清空前回收，防内存持续增长）

  function revokeResUrls(key) {
    var urls = resUrls[key] || [];
    for (var i = 0; i < urls.length; i++) {
      try { URL.revokeObjectURL(urls[i]); } catch (e) { /* 忽略 */ }
    }
    resUrls[key] = [];
  }

  function trackResUrls(key, items) {
    var list = resUrls[key] || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].url) list.push(items[i].url);
    }
    resUrls[key] = list;
  }

  function clearResult(key) {
    var box = $('#result-' + key);
    if (box) { box.hidden = true; box.textContent = ''; }
    revokeResUrls(key);
    resStore[key] = [];
  }

  function resultHead(key, items) {
    var head = document.createElement('div');
    head.className = 'res-head';
    var zipBtn = document.createElement('button');
    zipBtn.className = 'btn ghost sm';
    zipBtn.type = 'button';
    zipBtn.textContent = '全部打包为 ZIP';
    zipBtn.addEventListener('click', function () { zipAndSave(key, 'PDF输出_' + stamp() + '.zip'); });
    head.appendChild(zipBtn);
    var tip = document.createElement('span');
    tip.className = 'merge-count';
    tip.textContent = items.length + ' 个输出';
    head.appendChild(tip);
    return head;
  }

  function noteEl(text) {
    var n = document.createElement('div');
    n.className = 'result-note';
    n.textContent = text;
    return n;
  }

  function showRows(key, items, note) {
    var box = $('#result-' + key);
    revokeResUrls(key);
    resStore[key] = items;
    trackResUrls(key, items);
    box.hidden = false;
    box.textContent = '';
    if (note) box.appendChild(noteEl(note));
    if (items.length > 1) box.appendChild(resultHead(key, items));
    var list = document.createElement('div');
    list.className = 'result-files';
    items.forEach(function (it, idx) {
      var row = document.createElement('div');
      row.className = 'res-row';
      var nm = document.createElement('span');
      nm.className = 'r-name';
      nm.textContent = it.name;
      nm.title = it.name;
      row.appendChild(nm);
      var meta = document.createElement('span');
      meta.className = 'r-meta';
      meta.textContent = it.meta || '';
      row.appendChild(meta);
      var btn = document.createElement('button');
      btn.className = 'r-save';
      btn.type = 'button';
      btn.textContent = '保存';
      btn.addEventListener('click', function () { saveItem(key, idx); });
      row.appendChild(btn);
      list.appendChild(row);
    });
    box.appendChild(list);
  }

  function showGrid(key, items, note) {
    var box = $('#result-' + key);
    revokeResUrls(key);
    resStore[key] = items;
    trackResUrls(key, items);
    box.hidden = false;
    box.textContent = '';
    if (note) box.appendChild(noteEl(note));
    if (items.length > 1) box.appendChild(resultHead(key, items));
    var grid = document.createElement('div');
    grid.className = 'res-grid';
    items.forEach(function (it, idx) {
      var cell = document.createElement('div');
      cell.className = 'res-thumb';
      var img = document.createElement('img');
      img.src = it.url;
      img.alt = it.name;
      img.loading = 'lazy';
      cell.appendChild(img);
      var btn = document.createElement('button');
      btn.className = 't-save';
      btn.type = 'button';
      btn.textContent = '保存';
      btn.addEventListener('click', function () { saveItem(key, idx); });
      cell.appendChild(btn);
      grid.appendChild(cell);
    });
    box.appendChild(grid);
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function itemBlob(it) {
    if (it.blob) return Promise.resolve(it.blob);
    return Promise.resolve(new Blob([it.bytes], { type: it.mime || 'application/pdf' }));
  }

  function saveItem(key, idx) {
    var it = (resStore[key] || [])[idx];
    if (!it) return;
    itemBlob(it).then(function (blob) { return saveBlob(blob, it.name); }).then(function (how) {
      if (how === 'saved') setStatus('已保存：' + it.name, 'ok');
    });
  }

  /**
   * 保存单文件：WebView2 支持 File System Access API 时弹系统"另存为"对话框，
   * 否则回退浏览器下载（WebView2 默认下载 UI）。
   */
  async function saveBlob(blob, suggestedName) {
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        var ext = (suggestedName.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
        var opts = { suggestedName: suggestedName };
        if (ext) {
          opts.types = [{ description: ext.toUpperCase() + ' 文件', accept: {} }];
          opts.types[0].accept['.' + ext] = [blob.type || 'application/octet-stream'];
        }
        var handle = await window.showSaveFilePicker(opts);
        var w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        return 'saved';
      } catch (e) {
        // 用户点取消（AbortError）返回 cancel；NotAllowedError（如大文件打包超出
        // transient activation 有效期）与其它异常一样回退浏览器下载
        if (e && e.name === 'AbortError') return 'cancel';
      }
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    return 'downloaded';
  }

  async function zipAndSave(key, zipName) {
    var items = resStore[key] || [];
    if (!items.length) return;
    setStatus('正在打包…');
    try {
      var zip = new global.JSZip();
      var used = {};
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var nm = it.name;
        if (used[nm]) {
          var dot = nm.lastIndexOf('.');
          nm = nm.slice(0, dot) + '_' + (i + 1) + nm.slice(dot);
        }
        used[nm] = 1;
        if (it.blob) zip.file(nm, it.blob);
        else zip.file(nm, it.bytes);
      }
      var blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      var how = await saveBlob(blob, zipName);
      if (how === 'cancel') setStatus(''); // 还原状态条，不能卡在"正在打包…"
      else setStatus('打包完成：' + zipName, 'ok');
    } catch (e) {
      setStatus('打包失败：' + e.message, 'err');
    }
  }

  /* ─────────── 分段控件 ─────────── */

  function wireSeg(id, onChange) {
    var seg = $('#' + id);
    if (!seg) return;
    seg.addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn');
      if (!btn) return;
      $$('#' + id + ' .seg-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      if (onChange) onChange(btn.dataset.v);
    });
  }

  function segValue(id) {
    var active = document.querySelector('#' + id + ' .seg-btn.active');
    return active ? active.dataset.v : null;
  }

  function setSeg(id, value) {
    $$('#' + id + ' .seg-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.v === String(value));
    });
  }

  /* ─────────── 工具切换 ─────────── */

  function switchTool(tool) {
    $$('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === tool); });
    $$('.tool-page').forEach(function (p) { p.classList.toggle('active', p.id === 'page-' + tool); });
    var page = $('#page-' + tool);
    if (page) {
      $('#tool-title').textContent = page.dataset.title || '';
      $('#tool-desc').textContent = page.dataset.desc || '';
    }
    saveSetting('lastTool', tool);
  }

  /* ─────────── 启动 ─────────── */

  async function boot() {
    // 全局拖放兜底：拖到非拖放区松手不能让 webview 导航去打开文件（否则全部状态清零）
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    // 侧栏导航
    $$('.nav-item').forEach(function (b) {
      b.addEventListener('click', function () { switchTool(b.dataset.tool); });
    });

    // 分段控件（工具处理逻辑里的持久化在 tools.js）
    wireSeg('comp-level', function () { Tools.persistCompress(); });
    $('#comp-meta').addEventListener('change', function () { Tools.persistCompress(); });
    wireSeg('split-mode', function (v) {
      $('#split-every-row').hidden = v !== 'every';
      $('#split-range-row').hidden = v !== 'range';
      Tools.persistSplit();
    });
    $('#split-every').addEventListener('change', function () { Tools.persistSplit(); });
    wireSeg('toimg-fmt', function () { Tools.persistToimg(); });
    wireSeg('toimg-dpi', function () { Tools.persistToimg(); });
    $('#toimg-pages').addEventListener('change', function () { Tools.persistToimg(); });
    wireSeg('toppt-size', function () { Tools.persistToppt(); });
    wireSeg('toppt-quality', function () { Tools.persistToppt(); });

    // 拖放区（watermark 的 onAdded 交给 tools.js 触发预览）
    wireDropzone('compress', ['pdf']);
    wireDropzone('split', ['pdf']);
    wireDropzone('wm', ['pdf'], function () { Tools.onFilesAdded(); });
    wireDropzone('extract', ['pdf']);
    wireDropzone('toimg', ['pdf']);
    wireDropzone('toword', ['pdf']);
    wireDropzone('toppt', ['pdf']);
    wireDropzone('toxls', ['pdf']);

    // 合并工具的可视化编辑器
    if (typeof window.MergeTool !== 'undefined') window.MergeTool.init(Api);

    // 运行按钮 → tools.js
    ['compress', 'split', 'wm', 'extract', 'toimg', 'toword', 'toppt', 'toxls'].forEach(function (key) {
      var btn = $('#run-' + key);
      if (btn) btn.addEventListener('click', function () {
        var fn = window.Tools && window.Tools[key];
        if (!fn) return;
        Promise.resolve(fn()).catch(function (e) {
          setStatus('执行失败：' + (e && e.message ? e.message : e), 'err');
        });
      });
    });

    // 水印控件装配在 tools.js
    if (typeof window.Tools !== 'undefined') window.Tools.initControls(Api);

    // 恢复上次设置
    try {
      var last = await loadSetting('lastTool');
      if (last && $('#page-' + last)) switchTool(last);
      var c = await loadSetting('compress');
      if (c && c.level) setSeg('comp-level', c.level);
      if (c && c.meta === false) $('#comp-meta').checked = false;
      var sp = await loadSetting('split');
      if (sp) {
        if (sp.mode) setSeg('split-mode', sp.mode);
        $('#split-every-row').hidden = sp.mode !== 'every';
        $('#split-range-row').hidden = sp.mode !== 'range';
        if (sp.every) $('#split-every').value = sp.every;
      }
      var ti = await loadSetting('toimg');
      if (ti) {
        if (ti.fmt) setSeg('toimg-fmt', ti.fmt);
        if (ti.dpi) setSeg('toimg-dpi', ti.dpi);
        if (ti.pages != null) $('#toimg-pages').value = ti.pages;
      }
      var tp = await loadSetting('toppt');
      if (tp) {
        if (tp.size) setSeg('toppt-size', tp.size);
        if (tp.q) setSeg('toppt-quality', tp.q);
      }
      var wms = await loadSetting('wm');
      if (wms && window.Tools) window.Tools.applyWmSetting(wms);
    } catch (e) { /* 设置恢复失败不影响使用 */ }

    try {
      if (global.spark && global.spark.onEnter) global.spark.onEnter(function () {});
    } catch (e) { /* 忽略 */ }
  }

  /* ─────────── 对外接口（tools.js / merge.js 使用） ─────────── */

  var Api = {
    $: $,
    $$: $$,
    engine: E,
    session: session,
    renderFiles: renderFiles,
    setFileState: setFileState,
    setFilesLocked: setFilesLocked,
    setStatus: setStatus,
    progShow: progShow,
    progUpdate: progUpdate,
    progHide: progHide,
    saveBlob: saveBlob,
    saveItem: saveItem,
    showRows: showRows,
    showGrid: showGrid,
    notify: notify,
    fmtSize: function (n) { return E.formatBytes(n); },
    stripPdfExt: stripPdfExt,
    stamp: stamp,
    loadSetting: loadSetting,
    saveSetting: saveSetting,
    switchTool: switchTool,
    yieldFrame: yieldFrame
  };
  global.App = Api;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { boot(); });
    } else {
      boot();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);