/* shell.js — 外壳层：页面加固段 / 入口三通道 / 打开与保存流程 / 草稿 / 全模块装配
 *
 * 约定（架构 §6.5/§9/ADR-4/ADR-10）：
 * - 加固段最先注册（capture），contenteditable 豁免扩展；本文件只做加固与
 *   编排，不做坐标换算。快捷键分发在 interact.js（集中键表）。
 * - 保存走 FSA showSaveFilePicker 主 + 下载兜底（toolkit saveBlob 先例移植），
 *   不声明 fs.read/fs.write（文本语义读二进制 PDF 是静默损坏，ADR-4/ADR-10）。
 * - 草稿：sha256 前 16 hex 为 docId；draft:<docId> + asset:<hash> 双 key，
 *   自动保存 debounce 2s + onClose 兜底；恢复校验 docId 匹配（model.parseDraft）。
 * - 三通道：空参唤醒（主）/ regex 路径引导卡（需选择确认）/ 手选与拖放。
 *   openChannel 隔离入口差异，宿主 fs v2 若开放二进制语义在此单点升级。
 *
 * @see [架构方案 §7/§9](../../../docs/插件开发/PDF编辑器-架构方案.md)
 */
(function (global) {
  'use strict';

  var PDFED = global.PDFED = global.PDFED || {};
  var G = PDFED.geometry;
  var M = PDFED.model;
  var C = PDFED.commands;
  var H = PDFED.history;
  /* ── 页面加固：屏蔽默认右键菜单与浏览器快捷键（shell 最先注册，capture） ──
   * 本插件差异：豁免选择器扩 [contenteditable]（文本框就地编辑依赖右键粘贴）；
   * 其余与宿主文档 §12 模板逐字一致。编辑器快捷键体系在 interact.js 绕行协同。 */
  document.addEventListener('contextmenu', function (e) {
    if (e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable="plaintext-only"], [contenteditable="true"]')) return;
    e.preventDefault();
  });
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    var editing = e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable="plaintext-only"], [contenteditable="true"]');
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

  /* ── 工具 ── */

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      if (t) clearTimeout(t);
      t = setTimeout(fn, typeof arguments[0] === 'number' ? arguments[0] : 2000);
    };
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  async function sha256Hex16(bytes) {
    var buf = await crypto.subtle.digest('SHA-256', bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    var a = new Uint8Array(buf), s = '';
    for (var i = 0; i < 8; i++) s += ('0' + a[i].toString(16)).slice(-2);
    return s;
  }

  function xhrBytes(url) {
    return new Promise(function (res, rej) {
      var x = new XMLHttpRequest();
      x.open('GET', url);
      x.responseType = 'arraybuffer';
      x.onload = function () { res(new Uint8Array(x.response)); };
      x.onerror = function () { rej(new Error('资源加载失败 ' + url)); };
      x.send();
    });
  }

  /** saveBlob：FSA 主 + 下载兜底（toolkit app.js 先例移植，含取消/超限分支） */
  async function saveBlob(blob, suggestedName) {
    if (typeof global.showSaveFilePicker === 'function') {
      try {
        var ext = (suggestedName.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
        var opts = { suggestedName: suggestedName };
        if (ext) {
          opts.types = [{ description: ext.toUpperCase() + ' 文件', accept: {} }];
          opts.types[0].accept['.' + ext] = [blob.type || 'application/octet-stream'];
        }
        var handle = await global.showSaveFilePicker(opts);
        var w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        return 'saved';
      } catch (e) {
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

  /* ── boot：DOM 就绪装配 ── */

  async function boot() {
    var store = PDFED.store.createStore();
    var history = H.createHistory({ limit: 100 });
    var scrollEl = document.getElementById('canvas-scroll');
    var pagesLayer = document.getElementById('pages-layer');
    var toastEl = document.getElementById('toast');
    var toastTimer = null;
    function toast(msg, ms) {
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, ms || 2600);
    }

    var renderer = PDFED.render.createRenderer({
      scrollEl: scrollEl, pagesLayer: pagesLayer,
      onViewportChange: function (pageId) { store.change('meta', { patch: { activePageId: pageId } }); },
      onZoomChange: function (z) { updateZoomLabel(z); },
      notify: function (kind, msg) { toast(msg); }
    });
    var overlayView = PDFED.overlayView.createOverlayView({
      renderer: renderer, store: store, document: document,
      getAssetDataUrl: getAssetDataUrl
    });
    var interact = PDFED.interact.createInteract({
      renderer: renderer, store: store, history: history,
      scrollEl: scrollEl, document: document, toast: toast,
      zoom: function (k) { renderer.zoomTo(renderer.getScale() * k); },
      zoomFit: function () { renderer.zoomFitWidth(); }
    });
    overlayView.unsubs && interact.bindOverlayView(overlayView);
    var pagesUi = PDFED.pages.createPages({
      renderer: renderer, store: store, history: history,
      thumbEl: document.getElementById('thumbs'),
      document: document, toast: toast, overlayView: overlayView
    });
    pagesUi.attach();
    interact.attach();
    overlayView.syncAll();

    /* ── 状态 ── */
    var docBytes = null;           // 原始字节（导出用；render 持有自己的副本）
    var fontBytes = null;
    var current = null;            // { docId, origName }
    var saving = false;

    try { fontBytes = await xhrBytes('assets/vendor/fonts/NotoSansSC-GB2312-Regular.ttf'); }
    catch (e) { toast('中文字体加载失败，中文导出将不可用'); }

    /* ── 入口三通道 ── */
    function entryChannel() {
      var spark = global.spark;
      var text = spark && spark.input ? (spark.input.text || '') : '';
      if (text && /\.(pdf|PDF)$/.test(text.trim())) {
        showOpenGuide(text.trim());                       // ② 路径引导卡（需选择确认）
      } else {
        showEmptyState();
      }
    }
    function showOpenGuide(path) {
      var guide = document.getElementById('open-guide');
      guide.querySelector('.guide-path').textContent = path;
      guide.classList.remove('hidden');
      document.getElementById('empty-state').classList.add('hidden');
      guide.querySelector('#guide-open-btn').onclick = function () { pickFile(); };
    }
    function showEmptyState() {
      document.getElementById('empty-state').classList.remove('hidden');
      var guide = document.getElementById('open-guide');
      if (guide) guide.classList.add('hidden');
    }

    function pickFile() {
      document.getElementById('file-input').click();
    }
    document.getElementById('file-input').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) openFile(f);
    });
    /* 全窗口拖放 */
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && /\.pdf$/i.test(f.name)) openFile(f);
    });

    /* ── 打开流程 ── */
    var opening = false;
    async function openFile(file) {
      if (opening || saving) return;
      try {
        toast('正在打开 ' + file.name + '…');
        var buf = new Uint8Array(await file.arrayBuffer());
        await openBytes(buf, file.name);
      } catch (e) {
        toast('打开失败：' + ((e && e.message) || e), 4000);
      }
    }

    async function openBytes(bytes, origName) {
      if (saving || opening) return;
      opening = true;
      try {
        /* 加密探测：pdf.js 可开但 pdf-lib 拒绝的文档，编辑受限（架构 §9.3） */
        try {
          await global.PDFLib.PDFDocument.load(bytes);
        } catch (e) {
          toast('该 PDF 已加密，无法编辑（可先用 PDF工具箱 压缩重存为无加密副本）', 5000);
          return;
        }
        var docId = await sha256Hex16(bytes);
        /* openDocument 只解析+提取 pageParams；页模型在此构建，setOrder 由本函数显式调
         * （buildFrame 唯一入口，真机 P0：漏调 = 画布静默空白） */
        var doc = await renderer.openDocument(bytes, { docId: docId, origName: origName });
        var count = renderer.pageCountSrc();
        var pages = [];
        for (var i = 0; i < count; i++) {
          var pg = M.makePage({ srcIndex: i });
          pg.id = M.nextId(withCounters(), 'pg');   // 计数器宿主唯一：store.state.counters（字面量新对象会让所有页都叫 pg_1）
          pages.push(pg);
        }
        current = { docId: docId, origName: origName };
        docBytes = bytes;
        history.clear();                             // 撤销栈跨文档隔离（A 的快照灌进 B 必乱）
        renderer.setOrder(pages);                    // 先建 frame：doc-open 的订阅方（syncAll/thumbs）依赖 overlayLayerOf 可解析
        store.change('doc-open', { doc: { docId: docId, origName: origName, pageCount: count }, pages: pages });
        document.getElementById('empty-state').classList.add('hidden');
        document.getElementById('open-guide').classList.add('hidden');
        document.getElementById('doc-header').classList.remove('hidden');
        document.getElementById('doc-name').textContent = origName;
        pushRecent({ name: origName, docId: docId, at: Date.now() });
        tryRestoreDraft(docId);
        toast('已打开：' + origName + '（' + count + ' 页）');
      } finally {
        opening = false;
      }
    }

    /* 覆盖物 id 分配需要持久计数器：nextId 调用方持有 counters。
     * 打开流程用临时对象分配页 id；恢复草稿时 counters 由 parseDraft.recount 重建，
     * store.state.counters 由草稿接管（见 tryRestoreDraft）。 */
    function withCounters() { return store.get().counters || (store.get().counters = { ov: 0, pg: 0, as: 0 }); }

    /* ── 草稿 ── */
    function draftKey() { return 'draft:' + (current && current.docId || ''); }

    var scheduleAutosave = debounce(function () { saveDraftNow(); }, 2000);
    store.subscribe('overlays', scheduleAutosave);
    store.subscribe('pages', scheduleAutosave);

    async function saveDraftNow() {
      if (!current || !store.get().dirty) return;
      try {
        var d = M.makeDraft({ docId: current.docId, origName: current.origName });
        d.pages = M.clone(store.get().pages);
        d.overlays = M.clone(store.get().overlays);
        d.assets = M.clone(store.get().assets);
        d.counters = M.clone(store.get().counters || { ov: 0, pg: 0, as: 0 });
        d.savedAt = Date.now();
        await global.spark.db.set('draft:' + current.docId, JSON.parse(M.serializeDraft(d)));
        await pruneDrafts();
      } catch (e) {
        toast('草稿保存失败，请及时导出', 4000);
      }
    }

    async function tryRestoreDraft(docId) {
      try {
        var raw = await global.spark.db.get('draft:' + docId);
        if (!raw) return;
        var draft = M.parseDraft(typeof raw === 'string' ? raw : JSON.stringify(raw), { docId: docId });
        var mins = draft.savedAt ? Math.max(1, Math.round((Date.now() - draft.savedAt) / 60000)) : 0;
        if (!draft.overlays.length) return;
        if (confirmAction('发现 ' + mins + ' 分钟前的未导出编辑草稿（' + draft.overlays.length + ' 个元素），恢复吗？')) {
          store.change('draft-restore', { draft: draft });   // 唯一写口：多字段原子替换 + 标脏
          renderer.setOrder(store.get().pages);              // frame 重建（草稿页 id 与新开页序不同）
          overlayView.syncAll();
          toast('已恢复草稿');
        }
      } catch (e) {
        /* 草稿损坏/不匹配：静默忽略（孤儿由 LRU 清理） */
      }
    }

    async function pruneDrafts() {
      try {
        var keys = await global.spark.db.keys();
        var drafts = keys.filter(function (k) { return k.indexOf('draft:') === 0; });
        if (drafts.length <= 5) return;
        var sorted = [];
        for (var i = 0; i < drafts.length; i++) {
          var raw = await global.spark.db.get(drafts[i]);
          var at = raw && raw.savedAt ? raw.savedAt : 0;
          sorted.push({ key: drafts[i], at: at });
        }
        sorted.sort(function (a, b) { return a.at - b.at; });
        for (var j = 0; j < sorted.length - 5; j++) {
          var d = await global.spark.db.get(sorted[j].key);
          var assetKeys = Object.keys((d && d.assets) || {}).map(function (id) { return d.assets[id].dbKey; });
          await global.spark.db.remove(sorted[j].key);
          for (var k = 0; k < assetKeys.length; k++) await global.spark.db.remove(assetKeys[k]);
        }
      } catch (e) { /* 清理失败不阻断 */ }
    }

    /* 最近文件（空态列表） */
    async function pushRecent(item) {
      try {
        var list = (await global.spark.db.get('recent')) || [];
        list = list.filter(function (r) { return r.docId !== item.docId; });
        list.unshift(item);
        await global.spark.db.set('recent', list.slice(0, 5));
      } catch (e) { }
    }

    /* asset 数据访问 */
    async function getAssetDataUrl(assetId) {
      try {
        var a = store.get().assets[assetId];
        if (!a) return null;
        var b64 = await global.spark.db.get(a.dbKey);
        return b64 ? ('data:' + a.mime + ';base64,' + b64) : null;
      } catch (e) { return null; }
    }

    /* ── 插入图片 ── */
    async function insertImageFile(file) {
      if (!current) { toast('请先打开 PDF'); return; }
      try {
        var buf = new Uint8Array(await file.arrayBuffer());
        if (buf.length > 8 * 1024 * 1024) { toast('图片超过 8MB 上限'); return; }
        var mime = /png/i.test(file.type) ? 'image/png' : 'image/jpeg';
        var hash = await sha256Hex16(buf);
        var dbKey = 'asset:' + hash;
        await global.spark.db.set(dbKey, bytesToBase64(buf));
        var img = new Image();
        img.src = 'data:' + mime + ';base64,' + bytesToBase64(buf);
        await new Promise(function (r) { img.onload = r; img.onerror = r; });
        var pageId = store.get().activePageId;
        var o = M.makeOverlay('image', {
          pageId: pageId, x: 40, y: 40, w: 180, h: 140, z: store.topZ(pageId) + 1
        });
        o.image = { assetId: nextAssetId(), naturalW: img.naturalWidth, naturalH: img.naturalHeight };
        var st = store.get();
        st.assets[o.image.assetId] = { id: o.image.assetId, mime: mime, w: img.naturalWidth, h: img.naturalHeight, dbKey: dbKey };
        var cmd = C.addOverlay(store, o, st.assets[o.image.assetId]);
        store.change('overlay-add', { overlay: o, asset: st.assets[o.image.assetId] });
        history.push(cmd);
        store.change('selection-set', { ids: [o.id] });
        toast('图片已插入（可拖拽调整）');
      } catch (e) {
        toast('插入图片失败：' + ((e && e.message) || e));
      }
    }
    function bytesToBase64(bytes) {
      var bin = '';
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
      }
      return btoa(bin);
    }
    function nextAssetId() {
      var st = store.get();
      st.counters = st.counters || { ov: 0, pg: 0, as: 0 };
      st.counters.as = (st.counters.as || 0) + 1;
      return 'as_' + st.counters.as;
    }

    /* ── 保存 ── */
    document.getElementById('btn-save').addEventListener('click', saveNow);
    async function saveNow() {
      if (!current) { toast('请先打开 PDF'); return; }
      if (saving) return;
      saving = true;
      var modal = document.getElementById('save-modal');
      modal.classList.remove('hidden');
      try {
        /* 收集 asset 字节 */
        var assets = {};
        var st = store.get();
        var ids = Object.keys(st.assets);
        for (var i = 0; i < ids.length; i++) {
          var a = st.assets[ids[i]];
          var b64 = await global.spark.db.get(a.dbKey);
          if (b64) assets[ids[i]] = { mime: a.mime, bytes: base64ToBytes(b64) };
        }
        var result = await PDFED.export.exportPdf({
          bytes: docBytes, pages: st.pages, overlays: st.overlays, assets: assets,
          fontBytes: fontBytes,
          PDFLib: global.PDFLib, fontkit: global.fontkit,
          rasterizeLine: rasterizeLine
        });
        if (result.warnings && result.warnings.length)
          toast('导出完成（' + result.warnings.length + ' 处降级，详见状态）', 4000);
        var blob = new Blob([result.bytes], { type: 'application/pdf' });
        /* 注意：此处必须调下方 suggested() 函数——若在此声明同名 var 会函数级
         * 提升遮蔽函数名，调用变成字符串调用 → 保存必炸（真机 P1 实测） */
        var how = await saveBlob(blob, suggested(current.origName));
        if (how === 'saved' || how === 'downloaded') {
          store.change('save-marked');
          toast(how === 'saved' ? '已保存' : '已开始下载');
          await pruneDrafts();
        }
        modal.classList.add('hidden');
      } catch (e) {
        modal.classList.add('hidden');
        toast('保存失败：' + ((e && e.message) || e), 5000);
      } finally {
        saving = false;
      }
    }
    function suggested(name) {
      var base = (name || 'document').replace(/\.pdf$/i, '');
      return base + '-编辑.pdf';
    }
    function base64ToBytes(b64) {
      var bin = atob(b64);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    /* 缺字行栅格化兜底（浏览器 canvas）：导出端零排版，所见即所得 */
    async function rasterizeLine(text, style) {
      try {
        var pt = 16;                             // 栅格化字号（pt）
        var c = document.createElement('canvas');
        var ctx = c.getContext('2d');
        ctx.font = '500 ' + (pt * 4) + 'px "Noto Sans SC","Microsoft YaHei",sans-serif';
        var w = Math.ceil(ctx.measureText(text).width) + 8;
        var h = Math.ceil(pt * 4 * 1.4);
        c.width = w; c.height = Math.ceil(pt * 4 * 1.3);
        ctx = c.getContext('2d');
        ctx.font = '500 ' + (pt * 4) + 'px "Noto Sans SC","Microsoft YaHei",sans-serif';
        ctx.fillStyle = style && style.color || '#111111';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(text, 4, pt * 4);
        var b64 = c.toDataURL('image/png').split(',')[1];
        /* 4x 栅格 → pt 尺寸（保持清晰度）：wPt/hPt 按编辑字号折算 */
        var wPt = w / 4, hPt = c.height / 4;
        return { bytes: base64ToBytes(c.toDataURL('image/png').split(',')[1]), wPt: wPt, hPt: hPt };
      } catch (e) { return null; }
    }

    function confirmAction(msg) {
      return global.confirm ? global.confirm(msg) : true;
    }

    /* ── 工具栏与状态栏 ── */
    var tabBtns = document.querySelectorAll('[data-mode]');
    Array.prototype.forEach.call(tabBtns, function (b) {
      b.addEventListener('click', function () {
        store.change('meta', { patch: { mode: b.dataset.mode } });
        Array.prototype.forEach.call(tabBtns, function (x) { x.classList.toggle('tab-active', x === b); });
      });
    });
    document.getElementById('btn-open').addEventListener('click', pickFile);
    document.getElementById('btn-undo').addEventListener('click', function () { history.undo(); });
    document.getElementById('btn-redo').addEventListener('click', function () { history.redo(); });
    document.getElementById('btn-close').addEventListener('click', function () { global.spark.window.close(); });
    document.getElementById('btn-whiteout').addEventListener('click', function () { setTool('whiteout'); });
    document.getElementById('btn-highlight').addEventListener('click', function () { setTool('highlight'); });
    document.getElementById('btn-text').addEventListener('click', function () { setTool('text'); });
    document.getElementById('btn-image').addEventListener('click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg';
      input.onchange = function () { if (input.files[0]) insertImageFile(input.files[0]); };
      input.click();
    });
    function setTool(mode) {
      store.change('meta', { patch: { mode: mode } });
      toast({ text: '在页面上拖拽绘制文本框', whiteout: '在页面上拖拽覆盖白盒（遮盖原文）', highlight: '在页面上拖拽画高亮' }[mode] || '', 2200);
    }

    /* 缩放：Ctrl+滚轮（两段式）+ 状态栏 */
    scrollEl.addEventListener('wheel', function (e) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      var s = renderer.getScale() * (e.deltaY < 0 ? 1.15 : 1 / 1.15);
      renderer.zoomGesture(s);
      updateZoomLabel(Math.max(0.25, Math.min(4, s)) * 100);
    }, { passive: false });
    document.getElementById('zoom-in').addEventListener('click', function () {
      renderer.zoomTo(renderer.getScale() * 1.2); updateZoom();
    });
    document.getElementById('zoom-out').addEventListener('click', function () {
      renderer.zoomTo(renderer.getScale() / 1.2); updateZoom();
    });
    document.getElementById('zoom-fit').addEventListener('click', function () {
      renderer.zoomFitWidth(); updateZoom();
    });
    function updateZoom() { updateZoomLabel(renderer.getScale() * 100); }
    function updateZoomLabel(percent) {
      document.getElementById('zoom-value').textContent = Math.round(percent) + '%';
    }

    /* 状态栏：页码 / 保存状态 / dirty */
    store.subscribe('meta', function () {
      var st = store.get();
      var pages = st.pages;
      var idx = pages.findIndex(function (p) { return p.id === st.activePageId; });
      document.getElementById('page-indicator').textContent =
        pages.length ? '第 ' + (idx < 0 ? 1 : idx + 1) + ' / ' + pages.length + ' 页' : '未打开文档';
    });
    store.subscribe('overlays', updateSaveStatus);
    store.subscribe('pages', updateSaveStatus);
    store.subscribe('save', updateSaveStatus);
    function updateSaveStatus() {
      var st = store.get();
      document.getElementById('save-status').textContent = st.dirty ? '未保存' : (st.savedAt ? '已保存' : '—');
      document.getElementById('save-status').className = 'save-status ' + (st.dirty ? 'warn' : 'ok');
      document.getElementById('btn-undo').disabled = !history.canUndo();
      document.getElementById('btn-redo').disabled = !history.canRedo();
    }
    store.subscribe('selection', updatePropsPanel);
    updatePropsPanel();

    /* 属性面板（P0 精简版：字号/颜色/加粗/对齐/透明度/删除） */
    function updatePropsPanel() {
      var st = store.get();
      var panel = document.getElementById('props-panel');
      var sel = st.selection.length ? store.overlayById(st.selection[0]) : null;
      panel.classList.toggle('has-selection', !!sel);
      var body = document.getElementById('props-body');
      body.textContent = '';
      if (!sel) {
        body.innerHTML = '<div class="props-empty">未选中元素</div>' +
          '<div class="props-page">当前页：' + (st.pages.findIndex(function (p) { return p.id === st.activePageId; }) + 1) +
          ' / ' + st.pages.length + '</div>';
        return;
      }
      if (sel.type === 'text' && sel.text) {
        body.appendChild(propRow('字号', numberInput(sel.text.fontSize, function (v) {
          commitText({ fontSize: clamp(v, 4, 128) });
        })));
        body.appendChild(propRow('颜色', colorInput(sel.text.color, function (v) {
          commitText({ color: v });
        })));
        body.appendChild(propRow('加粗', toggleBtn(sel.text.bold, function (v) {
          commitText({ bold: v });
        })));
        body.appendChild(propRow('对齐', segmented(['left', 'center', 'right'], sel.text.align, function (v) {
          commitText({ align: v });
        })));
      } else if (sel.shape && sel.shape.kind !== 'rect') {
        body.appendChild(propRow('颜色', colorInput(sel.shape.fill, function (v) {
          commitPatch({ shape: { fill: v } });
        })));
      }
      body.appendChild(propRow('透明度', rangeInput(sel.opacity, function (v) {
        commitPatch({ opacity: v });
      })));
      var del = document.createElement('button');
      del.className = 'btn-danger';
      del.textContent = '删除（Delete）';
      del.addEventListener('click', function () {
        store.change('overlay-remove', { id: sel.id });
        history.push(C.removeOverlay(store, sel));
      });
      body.appendChild(del);
    }
    function commitText(patch) {
      var sel = store.get().selection;
      var o = sel.length ? store.overlayById(sel[0]) : null;
      if (!o) return;
      var before = { text: { fontSize: o.text.fontSize, color: o.text.color, bold: o.text.bold, align: o.text.align } };
      var after = { text: patch };
      store.change('overlay-update', { id: o.id, patch: after });
      history.push(C.updateOverlay(store, o.id, before, after, '文本属性'));
    }
    function commitPatch(patch) {
      var sel = store.get().selection;
      var o = sel.length ? store.overlayById(sel[0]) : null;
      if (!o) return;
      var before = {}, after = {};
      Object.keys(patch).forEach(function (k) {
        if (k === 'shape') { before.shape = M.clone(o.shape); after.shape = patch.shape; }
        else { before[k] = o[k]; after[k] = patch[k]; }
      });
      store.change('overlay-update', { id: o.id, patch: patch });
      history.push(C.updateOverlay(store, o.id, before, after, '属性'));
    }
    function propRow(label, input) {
      var row = document.createElement('div');
      row.className = 'prop-row';
      var lab = document.createElement('label');
      lab.textContent = label;
      row.appendChild(lab);
      row.appendChild(input);
      return row;
    }
    function numberInput(v, onSet) {
      var i = document.createElement('input');
      i.type = 'number'; i.value = v; i.className = 'prop-input';
      i.addEventListener('change', function () { onSet(parseFloat(i.value) || v); });
      return i;
    }
    function colorInput(v, onSet) {
      var i = document.createElement('input');
      i.type = 'color'; i.value = v || '#111111'; i.className = 'prop-color';
      i.addEventListener('input', function () { onSet(i.value); });
      return i;
    }
    function rangeInput(v, onSet) {
      var i = document.createElement('input');
      i.type = 'range'; i.min = '0.2'; i.max = '1'; i.step = '0.05'; i.value = String(v == null ? 1 : v);
      i.addEventListener('input', function () { onSet(parseFloat(i.value)); });
      return i;
    }
    function toggleBtn(v, onSet) {
      var b = document.createElement('button');
      b.className = 'prop-toggle' + (v ? ' on' : '');
      b.textContent = v ? '开' : '关';
      b.addEventListener('click', function () { onSet(!v); });
      return b;
    }
    function segmented(opts, cur, onSet) {
      var wrap = document.createElement('div');
      wrap.className = 'prop-seg';
      opts.forEach(function (o) {
        var b = document.createElement('button');
        b.className = 'prop-seg-btn' + (o === cur ? ' on' : '');
        b.textContent = { left: '左', center: '中', right: '右' }[o];
        b.addEventListener('click', function () { onSet(o); });
        wrap.appendChild(b);
      });
      return wrap;
    }

    store.subscribe('selection', updatePropsPanel);

    /* ── 生命周期 ── */
    if (global.spark && global.spark.onResize) global.spark.onResize(function (w) {
      document.body.classList.toggle('narrow', w < 720);
      document.body.classList.toggle('mid', w >= 720 && w < 1200);
    });
    if (global.spark && global.spark.onClose) global.spark.onClose(function () { saveDraftNow(); });
    pruneDrafts();
    entryChannel();
  }

  PDFED.shell = { boot: boot };
})(typeof window !== 'undefined' ? window : globalThis);