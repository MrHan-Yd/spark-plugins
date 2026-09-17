/* pages.js — 页面级操作 + 缩略图导航栏（编辑会话内排版需要，非工具箱批处理）
 *
 * 约定（架构 §0 功能红线 / §5.3）：
 * - 页删除 = 物理移除 + 组合命令快照撤销（pages-set + 该页覆盖物 remove/add 整组）；
 * - 页引用 srcIndex 允许重复（复制页复制原内容 + 覆盖物到新页 id）；
 * - 页面操作后同步 renderer.setOrder（frame 重建 + 滚动锚定）与缩略图；
 * - 缩略图懒渲染：可视卡才起 pdf.js 渲染（与主画布虚拟化同策）。
 *
 * @see [架构方案 §3/§6](../../../docs/插件开发/PDF编辑器-架构方案.md)
 */
(function (global) {
  'use strict';

  var PDFED = global.PDFED = global.PDFED || {};
  var M = PDFED.model;
  var C = PDFED.commands;
  var G = PDFED.geometry;

  var THUMB_W = 176;

  function createPages(opts) {
    var renderer = opts.renderer;
    var store = opts.store;
    var history = opts.history;
    var thumbEl = opts.thumbEl;                 // 缩略图容器
    var doc = opts.document;
    var toast = opts.toast || function () {};
    var thumbObserver = null;
    var dragFrom = -1;

    /* ── 组合命令：页面变更 + 关联覆盖物 ── */

    function composite(label, actions) {
      return {
        label: label,
        do: function () { actions.do(); },
        undo: function () { actions.undo(); }
      };
    }

    /** 旋转页（±90）：rotateDelta 归一入模型；覆盖物坐标不动（局部空间旋转不变性）。 */
    function rotatePage(pageId, delta) {
      var before = M.clone(store.get().pages);
      var pages = M.clone(before);
      var pg = pages.find(function (p) { return p.id === pageId; });
      if (!pg) return;
      pg.rotateDelta = G.normRotation((pg.rotateDelta || 0) + (delta || 90));
      var after = M.clone(pages);
      var cmd = composite('旋转页面', {
        do: function () { store.change('pages-set', { pages: M.clone(after) }); afterRender(); },
        undo: function () { store.change('pages-set', { pages: M.clone(before) }); afterRender(); }
      });
      store.change('pages-set', { pages: after });
      history.push(cmd);
      afterRender();
      function afterRender() {
        renderer.setOrder(store.get().pages, pageId);
        overlayViewSync();
      }
    }

    /** 删除页：该页覆盖物一并移除（组合命令整组撤销）。 */
    function removePage(pageId) {
      var pages = store.get().pages;
      if (pages.length <= 1) { toast('至少保留一页'); return; }
      var before = M.clone(pages);
      var removedOverlays = M.clone(store.overlaysOfPage(pageId));
      var idx = pages.findIndex(function (p) { return p.id === pageId; });
      var after = pages.filter(function (p) { return p.id !== pageId; });
      var cmd = composite('删除页面', {
        do: function () {
          store.change('pages-set', { pages: M.clone(after) });
          removedOverlays.forEach(function (o) { store.change('overlay-remove', { id: o.id }); });
          afterRender();
        },
        undo: function () {
          store.change('pages-set', { pages: M.clone(before) });
          removedOverlays.forEach(function (o) { store.change('overlay-add', { overlay: M.clone(o), asset: null }); });
          afterRender();
        }
      });
      store.change('pages-set', { pages: after });
      removedOverlays.forEach(function (o) { store.change('overlay-remove', { id: o.id }); });
      history.push(cmd);
      afterRender();
      toast('已删除第 ' + (idx + 1) + ' 页（可撤销）');
    }

    /** 复制页：原页内容（同 srcIndex）+ 覆盖物克隆到新页 id。 */
    function duplicatePage(pageId) {
      var pages = M.clone(store.get().pages);
      var src = pages.find(function (p) { return p.id === pageId; });
      if (!src) return;
      var idx = pages.findIndex(function (p) { return p.id === pageId; });
      var np = M.makePage({ srcIndex: src.srcIndex, rotateDelta: src.rotateDelta });
      np.id = M.nextId(store.get(), 'pg');
      pages.splice(idx + 1, 0, np);
      var clones = store.overlaysOfPage(pageId).map(function (o) {
        var c = M.clone(o);
        c.id = M.nextId(store.get(), 'ov');
        c.pageId = np.id;
        return c;
      });
      var before = M.clone(store.get().pages);
      var beforeOverlays = M.clone(store.overlaysOfPage(pageId));
      var cmd = composite('复制页面', {
        do: function () {
          store.change('pages-set', { pages: M.clone(pages) });
          clones.forEach(function (o) { store.change('overlay-add', { overlay: M.clone(o), asset: null }); });
          afterRender();
        },
        undo: function () {
          store.change('pages-set', { pages: M.clone(before) });
          clones.forEach(function (o) { store.change('overlay-remove', { id: o.id }); });
          afterRender();
        }
      });
      store.change('pages-set', { pages: pages });
      clones.forEach(function (o) { store.change('overlay-add', { overlay: M.clone(o), asset: null }); });
      history.push(cmd);
      afterRender();
      toast('已复制页（含 ' + beforeOverlays.length + ' 个编辑元素）');
    }

    /** 重排页（缩略图拖拽落点）：纯页序替换。 */
    function reorderPage(fromIdx, toIdx) {
      if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
      var before = M.clone(store.get().pages);
      var pages = M.clone(before);
      var moved = pages.splice(fromIdx, 1)[0];
      pages.splice(toIdx, 0, moved);
      var cmd = composite('重排页面', {
        do: function () { store.change('pages-set', { pages: M.clone(pages) }); afterRender(); },
        undo: function () { store.change('pages-set', { pages: M.clone(before) }); afterRender(); }
      });
      store.change('pages-set', { pages: pages });
      history.push(cmd);
      afterRender();
      function afterRender() {
        renderer.setOrder(store.get().pages, moved.id);
        overlayViewSync();
      }
    }
    function overlayViewSync() {
      if (opts.overlayView) opts.overlayView.syncAll();
    }
    function afterRender() {
      /* 延迟一帧：renderer.setOrder 重建 frame 后再同步覆盖物 DOM */
      requestAnimationFrame(function () { overlayViewSync(); });
    }

    /* ── 缩略图栏 ── */

    function renderThumbs() {
      thumbEl.textContent = '';
      var pages = store.get().pages;
      for (var i = 0; i < pages.length; i++) buildThumb(pages[i], i);
      setupThumbObserver();
      syncActive();
    }

    function buildThumb(p, idx) {
      var card = doc.createElement('div');
      card.className = 'thumb-card';
      card.dataset.pageId = p.id;
      card.dataset.idx = String(idx);
      card.draggable = true;
      var canvas = doc.createElement('canvas');
      canvas.className = 'thumb-canvas';
      var badge = doc.createElement('div');
      badge.className = 'thumb-badge';
      badge.textContent = String(idx + 1);
      var ops = doc.createElement('div');
      ops.className = 'thumb-ops';
      [['rotate', '↻', function () { rotatePage(p.id, 90); }],
       ['dup', '⧉', function () { duplicatePage(p.id); }],
       ['del', '✕', function () { removePage(p.id); }]].forEach(function (t) {
        var b = doc.createElement('button');
        b.className = 'thumb-op';
        b.title = { rotate: '顺时针旋转 90°', dup: '复制此页', del: '删除此页' }[t[0]];
        b.textContent = t[1];
        b.addEventListener('click', function (e) { e.stopPropagation(); t[2](); });
        ops.appendChild(b);
      });
      card.appendChild(canvas);
      card.appendChild(badge);
      card.appendChild(ops);
      card.addEventListener('click', function () {
        store.change('meta', { patch: { activePageId: p.id } });
        renderer.scrollToPage(p.id);
      });
      card.addEventListener('dragstart', function (e) {
        dragFrom = idx;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(idx)); } catch (err) { }
      });
      card.addEventListener('dragend', function () {
        card.classList.remove('dragging');
        clearDropMarks();
        dragFrom = -1;
      });
      thumbEl.appendChild(card);
    }

    function setupThumbObserver() {
      if (thumbObserver) thumbObserver.disconnect();
      thumbObserver = new IntersectionObserver(onThumbVisible, { root: thumbEl, rootMargin: '100% 0px' });
      Array.prototype.forEach.call(thumbEl.children, function (c) { thumbObserver.observe(c); });
    }

    async function renderThumbCanvas(card) {
      var p = store.pageById(card.dataset.pageId);
      if (!p || p.srcIndex == null || !renderer.getDoc()) return;
      var pdfPage = await renderer.getDoc().getPage(p.srcIndex + 1);
      var view = pdfPage.view;
      var ctxThumb = G.makePageCtx({
        cropX: view[0], cropY: view[1],
        cropW: view[2] - view[0], cropH: view[3] - view[1],
        scale: THUMB_W / (view[2] - view[0]),
        rotation: G.normRotation(pdfPage.rotate + (p.rotateDelta || 0))
      });
      var w = Math.round(ctxThumb.viewW), h = Math.round(ctxThumb.viewH);
      var canvas = card.querySelector('canvas');
      canvas.width = w; canvas.height = h;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      var viewport = pdfPage.getViewport({ scale: ctxThumb.scale });
      try {
        await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
      } catch (e) { /* RenderingCancelledException：被重渲取代 */ }
    }

    function onThumbVisible(entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          var card = entries[i].target;
          thumbObserver.unobserve(card);
          renderThumbCanvas(card);
        }
      }
    }

    function clearDropMarks() {
      Array.prototype.forEach.call(thumbEl.querySelectorAll('.drop-before'), function (c) {
        c.classList.remove('drop-before');
      });
    }

    function attachThumbDnD() {
      thumbEl.addEventListener('dragover', function (e) {
        var card = e.target.closest && e.target.closest('.thumb-card');
        clearDropMarks();
        if (!card || dragFrom < 0) return;
        e.preventDefault();
        card.classList.add('drop-before');
      });
      thumbEl.addEventListener('drop', function (e) {
        var card = e.target.closest && e.target.closest('.thumb-card');
        clearDropMarks();
        if (!card || dragFrom < 0) return;
        e.preventDefault();
        var to = Number(card.dataset.idx);
        reorderPage(dragFrom, to > dragFrom ? to - 1 : to);
        dragFrom = -1;
      });
    }

    function syncActive() {
      var active = store.get().activePageId;
      Array.prototype.forEach.call(thumbEl.children, function (c) {
        c.classList.toggle('thumb-active', c.dataset.pageId === active);
      });
    }

    function attach() {
      store.subscribe('pages', renderThumbs);
      store.subscribe('meta', function () {
        syncActive();
      });
      thumbEl.addEventListener('dragover', function (e) { if (dragFrom >= 0) e.preventDefault(); });
      attachThumbDnD();
    }

    return {
      attach: attach,
      renderThumbs: renderThumbs,
      rotatePage: rotatePage,
      removePage: removePage,
      duplicatePage: duplicatePage,
      reorderPage: reorderPage
    };
  }

  PDFED.pages = { createPages: createPages };
})(typeof window !== 'undefined' ? window : globalThis);