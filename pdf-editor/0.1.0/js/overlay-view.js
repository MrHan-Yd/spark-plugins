/* overlay-view.js — 覆盖物 DOM 同步层（L2）：store 订阅 → 页内全量重排
 *
 * 约定（架构 ADR-3/ADR-7 + UI 蓝图 §3.3/§3.4）：
 * - 覆盖物用 DOM 渲染（div/img/svg），命中/焦点/文本编辑免费拿；不用 canvas 自绘。
 * - 本层只订阅 store 全量重排（页内对象 <1k，精细 diff 不需要），视图永不回写
 *   store——所有变更走命令（commands.js）。
 * - 选中框 + 8 向手柄是 L3 浮动元素，由本层管理（柄的事件经 interact 委托）。
 * - 尺寸/位置全部经 geometry（rectPageToCss/lenPageToCss），本层不做坐标算术。
 * - 文本常态渲染 value 自动换行（所见即所得）；烘焙 lines 仅导出用。
 *
 * @see [架构方案 §4/§6](../../../docs/插件开发/PDF编辑器-架构方案.md)
 */
(function (global) {
  'use strict';

  var PDFED = global.PDFED = global.PDFED || {};
  var G = PDFED.geometry;

  function createOverlayView(opts) {
    var renderer = opts.renderer;
    var store = opts.store;
    var doc = opts.document;                  // window.document
    var unsubs = [];
    var editingId = null;                     // contenteditable 就地编辑中的对象 id

    /* ── 元素构建 ── */

    function buildElement(o) {
      var el = doc.createElement('div');
      el.className = 'ov ov-' + o.type;
      el.dataset.ovId = o.id;
      el.style.opacity = String(o.opacity == null ? 1 : o.opacity);
      if (o.locked) el.classList.add('ov-locked');
      if (o.type === 'text') {
        var box = doc.createElement('div');
        box.className = 'ov-text';
        if (o.text) {
          box.style.fontSize = G.lenPageToCss(o.text.fontSize, ctxOf(o)) + 'px';
          box.style.color = o.text.color || '#111111';
          box.style.fontWeight = o.text.bold ? '700' : '400';
          box.style.textAlign = o.text.align || 'left';
          box.style.lineHeight = String(o.text.lineHeight || 1.45);
          box.textContent = o.text.value || '';
        }
        el.appendChild(box);
      } else if (o.type === 'image' || o.type === 'signature') {
        var img = doc.createElement('img');
        img.className = 'ov-img';
        img.draggable = false;
        if (o.image && o.image.assetId) img.dataset.assetId = o.image.assetId;
        el.appendChild(img);
        /* 字节加载由 shell 层统一供给（spark.db 读 asset），本层只挂引用 */
      } else if (o.type === 'shape') {
        el.classList.add('ov-shape-' + (o.shape && o.shape.kind || 'rect'));
        if (o.shape) {
          el.style.background = o.shape.kind === 'rect' && o.shape.fill ? o.shape.fill : '';
          if (o.shape.kind === 'highlight') el.style.background = o.shape.fill || '#ffe066';
          if (o.shape.fillOpacity != null) el.style.opacity = String((o.opacity == null ? 1 : o.opacity) * o.shape.fillOpacity);
        }
      } else if (o.type === 'ink') {
        el.classList.add('ov-ink');
        var svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('ov-ink-svg');
        var poly = doc.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        svg.appendChild(poly);
        el.appendChild(svg);
      }
      return el;
    }

    function ctxOf(o) {
      var idx = renderer.orderIndexOf(o.pageId);
      return renderer.pageCtxOf(idx);
    }

    /** 页内全量重排（ADR-3：全量重排成本可接受，不做精细 diff）。 */
    function syncPage(pageId) {
      var layer = renderer.overlayLayerOf(pageId);
      if (!layer) return;
      var items = store.overlaysOfPage(pageId);
      layer.textContent = '';
      for (var i = 0; i < items.length; i++) {
        var o = items[i];
        var el = buildElement(o);
        placeElement(el, o, layer);
        if (o.type === 'text' && o.text && o.text.lines && !o.text.lines.length) {
          /* 行烘焙为空且文本非空：UI 提示降级状态（M4 兜底路径联动） */
          el.classList.add('ov-unsynced');
        }
        layer.appendChild(el);
      }
      syncSelectionHandles(pageId);
      syncImages(pageId);
    }

    function placeElement(el, o, layer) {
      var rect = G.rectPageToCss({ x: o.x, y: o.y, w: o.w, h: o.h }, ctxOf(o));
      el.style.left = rect.px + 'px';
      el.style.top = rect.py + 'px';
      el.style.width = rect.w + 'px';
      el.style.height = rect.h + 'px';
    }

    function syncImages(pageId) {
      var layer = renderer.overlayLayerOf(pageId);
      if (!layer) return;
      var imgs = layer.querySelectorAll('img.ov-img[data-asset-id]:not([src])');
      for (var i = 0; i < imgs.length; i++) {
        if (opts.getAssetDataUrl) {
          /* getAssetDataUrl 是 async（spark.db 读字节）：src 不能直接赋 Promise
           * （会变 "[object Promise]" 永远裂图），resolve 后回填 */
          (function (img, assetId) {
            Promise.resolve(opts.getAssetDataUrl(assetId)).then(function (url) {
              if (url && !img.src) img.src = url;
            });
          })(imgs[i], imgs[i].dataset.assetId);
        }
      }
    }

    /* ── 选中态与手柄（L3） ── */

    var handleLayer = null;                    // 挂在选中对象所在页的 layer 之上
    var HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

    function syncSelectionHandles(pageId) {
      if (handleLayer && handleLayer.parentNode) handleLayer.remove();
      handleLayer = null;
      var sel = store.get().selection;
      if (!sel || !sel.length || !pageId) return;
      /* P0 单选渲染手柄；多选只渲染包围框（成组操作 P1） */
      var o = store.overlayById(sel[0]);
      if (!o || o.pageId !== pageId) return;
      var layer = renderer.overlayLayerOf(pageId);
      if (!layer) return;
      var el = layer.querySelector('[data-ov-id="' + o.id + '"]');
      if (!el) return;
      el.classList.add('ov-selected');
      var h = doc.createElement('div');
      h.className = 'ov-handles';
      h.dataset.handleFor = o.id;
      for (var i = 0; i < HANDLES.length; i++) {
        var knob = doc.createElement('div');
        knob.className = 'ov-handle ov-handle-' + HANDLES[i];
        knob.dataset.handle = HANDLES[i];
        h.appendChild(knob);
      }
      el.appendChild(h);
      handleLayer = h;
    }

    /** 独立重绘选中态（selection 订阅入口）。 */
    function resyncSelection() {
      var activePageId = store.get().activePageId;
      var sel = store.get().selection;
      var pageId = null;
      if (sel && sel.length) {
        var o = store.overlayById(sel[0]);
        if (o) pageId = o.pageId;
      }
      if (!pageId) {
        /* 清所有页选中样式 */
        var pages = store.get().pages;
        for (var i = 0; i < pages.length; i++) {
          var layer = renderer.overlayLayerOf(pages[i].id);
          if (layer) {
            var old = layer.querySelectorAll('.ov-selected');
            for (var j = 0; j < old.length; j++) old[j].classList.remove('ov-selected');
            var hs = layer.querySelectorAll('.ov-handles');
            for (var k = 0; k < hs.length; k++) hs[k].remove();
          }
        }
        handleLayer = null;
        return;
      }
      syncPage(pageId);
    }

    /* ── 订阅 ── */

    function syncAll() {
      var pages = store.get().pages;
      for (var i = 0; i < pages.length; i++) syncPage(pages[i].id);
    }

    unsubs.push(store.subscribe('overlays', syncAll));
    unsubs.push(store.subscribe('pages', syncAll));
    unsubs.push(store.subscribe('selection', resyncSelection));

    return {
      syncAll: syncAll,
      syncPage: syncPage,
      /** 就地编辑中标记（interact 设置），重排时保持编辑元素不被重建。 */
      setEditing: function (id) { editingId = id; },
      getEditing: function () { return editingId; },
      unsubs: unsubs
    };
  }

  PDFED.overlayView = { createOverlayView: createOverlayView };
})(typeof window !== 'undefined' ? window : globalThis);