/* render.js — pdf.js 渲染层：文档打开/页面虚拟化/渲染队列/两段式缩放（视图层）
 *
 * 约定（架构 §6.1/6.2）：
 * - 架构性禁用 getOperatorList（toolkit op-list OOM 前科 R1）——只用 render()
 *   与 P1 的 getTextContent，均按页惰性；本文件任何分支不得引入算子级 API。
 * - 页面虚拟化：打开期只预取页尺寸（page.view/page.rotate，页字典级解析），
 *   滚动中可视 ±1 页渲染，离屏 cleanup；同页新渲染必先 cancel 旧 task
 *   并校验代际（防叠影竞态 R4）；渲染像素上限 16M，超限降 DPR 不改 CSS 尺寸。
 * - 两段式缩放：手势期 pagesLayer transform 即时反馈；落定 debounce 150ms
 *   重排 frame、重渲染、scroll 校正，清 transform。全程 transform 被否决
 *   （k>1 位图永久模糊 + 命中过逆矩阵 + 层对齐漂移）。
 * - 坐标：本文件只把 pdf.js 的 page.view/page.rotate 提取成纯参数喂
 *   geometry.makePageCtx，不做任何换算算术。
 *
 * @see [架构方案 §6](../../../docs/插件开发/PDF编辑器-架构方案.md)
 */
(function (global) {
  'use strict';

  var PDFED = global.PDFED = global.PDFED || {};
  var G = PDFED.geometry;

  var RENDER_PIXEL_LIMIT = 16 * 1024 * 1024;   // 单页渲染像素上限（R5）
  var QUEUE_CONCURRENCY = 2;
  var ZOOM_SETTLE_MS = 150;

  function createRenderer(opts) {
    var scrollEl = opts.scrollEl;             // 画布滚动容器
    var pagesLayer = opts.pagesLayer;         // 页面流容器（scrollEl 直接子级）
    var notify = opts.notify || function () {};
    var pdfDoc = null;
    var meta = null;                          // { docId, origName }
    /* 页静态参数（pdf.js 提取，打开期一次）：srcIndex → {cropX..cropH, rotate0} */
    var pageParams = [];                      // 下标 = 原文件页号（含 0 起）
    /* 编辑会话页序（store.pages 快照镜像）：[{id, srcIndex, rotateDelta}] */
    var pageOrder = [];
    var scale = 1;
    var gestureZoom = 1;
    var zoomTimer = null;
    var queue = [];                           // 待渲染 { pageIndex, dist }
    var active = new Map();                   // pageIndex → { renderTask, seq, canvas }
    var seqCounter = 0;
    var observer = null;
    var dpr = Math.max(1, Math.min(3, (global.devicePixelRatio || 1)));

    var G_DOC = global.pdfjsLib;

    /* ── 打开文档 ── */

    async function openDocument(bytes, docMeta, pages) {
      await destroy();
      /* pdf.js 会转移 buffer，喂副本（toolkit engine.js 先例，R3） */
      var data = bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes;
      var doc = await G_DOC.getDocument({
        data: data,
        cMapUrl: 'assets/vendor/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: 'assets/vendor/standard_fonts/'
      }).promise;
      pdfDoc = doc;
      meta = docMeta;
      pageParams = [];
      for (var i = 0; i < doc.numPages; i++) {
        var pg = await doc.getPage(i + 1);
        var view = pg.view;                          // CropBox [x0,y0,x1,y1]
        pageParams.push({
          cropX: view[0], cropY: view[1],
          cropW: view[2] - view[0], cropH: view[3] - view[1],
          rotate0: G.normRotation(pg.rotate)
        });
        pg.cleanup();
      }
      /* pages 契约（真机 P0 修复 2026-09-17）：可空——openDocument 只负责解析与
       * pageParams 提取；调用方（shell.openBytes）拿到 pageCount 构建页模型
       * （id 必须经 store.counters 分配）后必须显式 setOrder(pages)——
       * buildFrame 唯一入口在 setOrder，漏调 = 画布静默空白比崩溃更难追。 */
      if (pages) setOrder(pages);
      return doc;
    }

    /** 编辑会话页序（M6 重排/删页后重调）：重建 frame 流，保滚动锚定目标页。 */
    function setOrder(pages, anchorPageId) {
      pageOrder = pages.map(function (p) {
        return { id: p.id, srcIndex: p.srcIndex, rotateDelta: p.rotateDelta || 0 };
      });
      pagesLayer.textContent = '';
      for (var i = 0; i < pageOrder.length; i++) buildFrame(i);
      relayout();
      if (observer) observer.disconnect();
      setupObserver();
      if (anchorPageId) scrollToPage(anchorPageId);
    }

    function buildFrame(orderIndex) {
      var it = pageOrder[orderIndex];
      var frame = document.createElement('div');
      frame.className = 'pdf-page';
      frame.dataset.pageId = it.id;
      frame.dataset.orderIndex = String(orderIndex);
      var canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      var layer = document.createElement('div');
      layer.className = 'overlay-layer';
      frame.appendChild(canvas);
      frame.appendChild(layer);
      pagesLayer.appendChild(frame);
    }

    /** 重排所有 frame 尺寸（scale 或 rotateDelta 变化后调用）。 */
    function relayout() {
      for (var i = 0; i < pageOrder.length; i++) {
        var it = pageOrder[i];
        var frame = pagesLayer.children[i];
        if (!frame) continue;
        var ctx = pageCtxOf(i);
        frame.style.width = ctx.viewW + 'px';
        frame.style.height = ctx.viewH + 'px';
      }
    }

    /** orderIndex → geometry 换算上下文（唯一入口，含 rotateDelta 与 scale）。 */
    function pageCtxOf(orderIndex) {
      var it = pageOrder[orderIndex];
      var pp = pageParams[it.srcIndex];
      if (!pp) throw new Error('render: 页参数缺失 srcIndex=' + it.srcIndex);
      return G.makePageCtx({
        cropX: pp.cropX, cropY: pp.cropY, cropW: pp.cropW, cropH: pp.cropH,
        scale: scale, rotation: pp.rotate0 + it.rotateDelta
      });
    }

    function pageIdToOrderIndex(pageId) {
      for (var i = 0; i < pageOrder.length; i++) if (pageOrder[i].id === pageId) return i;
      return -1;
    }

    /* ── 虚拟化与渲染队列 ── */

    function setupObserver() {
      observer = new IntersectionObserver(onIntersect, {
        root: scrollEl, rootMargin: '80% 0px 80% 0px', threshold: 0
      });
      Array.prototype.forEach.call(pagesLayer.children, function (f) { observer.observe(f); });
    }

    function onIntersect(entries) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var idx = Number(e.target.dataset.orderIndex);
        if (e.isIntersecting) enqueue(idx);
        else evict(idx);
      }
      pump();
      notifyViewport();
    }

    function enqueue(orderIndex) {
      if (orderIndex < 0 || orderIndex >= pageOrder.length) return;
      for (var i = 0; i < queue.length; i++) if (queue[i].pageIndex === orderIndex) return;
      queue.push({ pageIndex: orderIndex, dist: 0 });
      pump();
    }

    function evict(orderIndex) {
      /* 离屏：取消待渲染 + 释放 canvas 位图（frame 占位尺寸仍在，无跳动） */
      var st = active.get(orderIndex);
      if (st && st.renderTask) { try { st.renderTask.cancel(); } catch (e) { /* 已结束 */ } }
      active.delete(orderIndex);
      var frame = pagesLayer.children[orderIndex];
      if (frame) {
        var canvas = frame.querySelector('canvas');
        if (canvas.width) { canvas.width = 0; canvas.height = 0; }
      }
      queue = queue.filter(function (q) { return q.pageIndex !== orderIndex; });
    }

    function pump() {
      if (!pdfDoc) return;
      while (rendering() < QUEUE_CONCURRENCY && queue.length) {
        var center = viewportCenterIndex();
        queue.forEach(function (q) {
          q.dist = Math.abs(q.pageIndex + 0.5 - center);
        });
        queue.sort(function (a, b) { return a.dist - b.dist; });
        var job = queue.shift();
        renderPage(job.pageIndex);
      }
    }
    /** 视口中心对应的页序（渲染优先级依据）；空文档返回 0。 */
    function viewportCenterIndex() {
      var center = scrollEl.scrollTop + scrollEl.clientHeight / 2;
      var best = 0, bestD = Infinity;
      for (var i = 0; i < pageOrder.length; i++) {
        var f = pagesLayer.children[i];
        if (!f) continue;
        var d = Math.abs(f.offsetTop + f.offsetHeight / 2 - center);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best + 0.5;
    }
    function rendering() {
      /* pending 计入 getPage 阶段（renderTask 尚未创建）：否则 pump 同步循环
       * 视其在途为空闲，一次 while 清空整条队列，虚拟化失效全页渲染 */
      var n = 0;
      active.forEach(function (st) { if (st.renderTask || st.pending) n++; });
      return n;
    }

    async function renderPage(orderIndex) {
      var it = pageOrder[orderIndex];
      if (!pdfDoc || !it) return;
      var frame = pagesLayer.children[orderIndex];
      if (!frame) return;
      var canvas = frame.querySelector('canvas');
      var seq = ((active.get(orderIndex) || {}).seq || 0) + 1;
      active.set(orderIndex, { renderTask: null, seq: seq, canvas: canvas, pending: true });
      var ctx = pageCtxOf(orderIndex);
      var pdfPage = await pdfDoc.getPage(it.srcIndex + 1);
      var viewport = pdfPage.getViewport({ scale: scale });
      /* R5 安全阀：像素超限降 DPR（CSS 尺寸不变，只降清晰度） */
      var useDpr = dpr;
      while (viewport.width * viewport.height * useDpr * useDpr > RENDER_PIXEL_LIMIT && useDpr > 0.5) useDpr -= 0.25;
      canvas.width = Math.max(1, Math.round(viewport.width * useDpr));
      canvas.height = Math.max(1, Math.round(viewport.height * useDpr));
      canvas.style.width = Math.round(viewport.width) + 'px';
      canvas.style.height = viewport.height + 'px';
      var rc = canvas.getContext('2d');
      var task = pdfPage.render({
        canvasContext: rc,
        viewport: viewport,
        transform: useDpr !== 1 ? [useDpr, 0, 0, useDpr, 0, 0] : null
      });
      var st = active.get(orderIndex);
      if (!st) { try { task.cancel(); } catch (e) { } return; }   // 等待期已被 evict
      st.renderTask = task;
      st.pending = false;
      try {
        await task.promise;
      } catch (e) {
        if (e && e.name === 'RenderingCancelledException') return;   // 已被新渲染取代
        notify('error', '第 ' + (orderIndex + 1) + ' 页渲染失败：' + (e && e.message || e));
        return;
      }
      if ((active.get(orderIndex) || {}).seq !== seq) return;      // 代际不符：过期上屏丢弃
      /* 完成后若已离屏（evict 已清）则不保留位图 */
    }

    function viewportCenter() {
      return (scrollEl.scrollTop + scrollEl.clientHeight / 2);
    }
    function notifyViewport() {
      var center = viewportCenter();
      var cur = null, best = Infinity;
      for (var i = 0; i < pageOrder.length; i++) {
        var frame = pagesLayer.children[i];
        if (!frame) continue;
        var mid = frame.offsetTop + frame.offsetHeight / 2;
        var d = Math.abs(mid - center);
        if (d < best) { best = d; cur = pageOrder[i].id; }
      }
      if (cur && opts.onViewportChange) opts.onViewportChange(cur);
    }

    function scrollToPage(pageId) {
      var idx = pageIdToOrderIndex(pageId);
      if (idx < 0) return;
      var frame = pagesLayer.children[idx];
      if (frame) scrollEl.scrollTop = frame.offsetTop;
    }

    /* ── 缩放（两段式） ── */

    /** 手势期：立即 transform 反馈（容忍模糊），挂起编辑交互由 interact 自查 gesture。 */
    function zoomGesture(k) {
      gestureZoom = Math.max(0.25, Math.min(4, k));
      pagesLayer.style.transformOrigin = '50% 0';
      pagesLayer.style.transform = 'scale(' + gestureZoom / scale + ')';
      if (zoomTimer) clearTimeout(zoomTimer);
      zoomTimer = setTimeout(function () { zoomTo(gestureZoom); }, ZOOM_SETTLE_MS);
    }

    /** 落定期：按目标 scale 重排 + 重渲染可视页 + 滚动校正。 */
    function zoomTo(k, anchorPageId) {
      var old = scale;
      var k2 = Math.max(0.25, Math.min(4, k));
      if (k2 === old) return;
      /* 滚动校正：保持视口中心相对文档的百分比位置 */
      var centerRatio = (scrollEl.scrollTop + scrollEl.clientHeight / 2) / Math.max(1, pagesLayer.offsetHeight);
      scale = k2;
      gestureZoom = 1;
      pagesLayer.style.transform = '';
      relayout();
      /* 清全部已渲染位图（尺寸全变了），可视页重新入队 */
      active.forEach(function (st, idx) {
        var frame = pagesLayer.children[idx];
        if (frame) {
          var c = frame.querySelector('canvas');
          c.width = 0; c.height = 0;
        }
      });
      active.clear();
      queue.length = 0;
      Array.prototype.forEach.call(pagesLayer.children, function (f, i) { enqueue(i); });
      var newH = pagesLayer.offsetHeight;
      scrollEl.scrollTop = Math.max(0, centerRatio * newH - scrollEl.clientHeight / 2);
      if (anchorPageId) scrollToPage(anchorPageId);
      if (opts.onZoomChange) opts.onZoomChange(scale);
    }

    function zoomFitWidth() {
      var first = pagesLayer.children[0];
      if (!first) return;
      var pad = 48;                                   /* 画布左右留白（与 CSS 同步） */
      var natural = pageOrder.length ? pageCtxOf(0).cropW : 595;
      var target = (scrollEl.clientWidth - pad * 2) / natural;
      zoomTo(Math.max(0.25, Math.min(4, target)));
    }

    /* ── 生命周期 ── */

    async function destroy() {
      if (observer) { observer.disconnect(); observer = null; }
      if (zoomTimer) { clearTimeout(zoomTimer); zoomTimer = null; }
      active.forEach(function (st) { if (st.renderTask) { try { st.renderTask.cancel(); } catch (e) { } } });
      active.clear();
      queue.length = 0;
      if (pdfDoc) { try { await pdfDoc.destroy(); } catch (e) { } pdfDoc = null; }
      pageParams = [];
      pageOrder = [];
      if (pagesLayer) pagesLayer.textContent = '';
      scale = 1;
      gestureZoom = 1;
    }

    return {
      openDocument: openDocument,
      destroy: destroy,
      setOrder: setOrder,
      relayout: relayout,
      pageCtxOf: pageCtxOf,
      pageIdToOrderIndex: pageIdToOrderIndex,
      orderIndexOf: function (pageId) { return pageIdToOrderIndex(pageId); },
      frameOf: function (pageId) {
        var idx = pageIdToOrderIndex(pageId);
        return idx < 0 ? null : pagesLayer.children[idx];
      },
      overlayLayerOf: function (pageId) {
        var f = this.frameOf(pageId);
        return f ? f.querySelector('.overlay-layer') : null;
      },
      scrollToPage: scrollToPage,
      zoomGesture: zoomGesture,
      zoomTo: zoomTo,
      zoomFitWidth: zoomFitWidth,
      getScale: function () { return scale; },
      getDoc: function () { return pdfDoc; },
      pageCountSrc: function () { return pageParams.length; },
      /** 手势期标志：interact 在此期间挂起命中/拖拽。 */
      isGesture: function () { return !!pagesLayer.style.transform; }
    };
  }

  PDFED.render = { createRenderer: createRenderer };
})(typeof window !== 'undefined' ? window : globalThis);