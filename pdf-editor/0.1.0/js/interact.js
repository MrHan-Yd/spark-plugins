/* interact.js — 编辑引擎层：指针交互（选/拖/缩放柄/绘制）+ 快捷键集中分发（视图层）
 *
 * 纪律（架构 §6.3/§6.5）：
 * - 所有指针/键盘事件 → geometry 换算 → store（经命令）；拖动中间态只改 DOM，
 *   pointerup 一次性生成命令入栈——撤销栈不被拖动中间态污染。
 * - 加固段在 shell.js（页面级，先于本层注册）；本层只做快捷键分发：
 *   SHORTCUTS 集中键表 + 单一 keydown 分发器（bubble 阶段），禁止散落
 *   addEventListener('keydown')。redo 用 Ctrl+Y / Ctrl+Shift+Z——Ctrl+R 已被
 *   加固段在非编辑焦点拦截，永不用作 redo 语义（防后人手痒，ADR-9）。
 * - 命中：覆盖物是 DOM，事件由元素自身承接（本层统一委托 pointerdown 到
 *   [data-ov-id]，不做全局几何命中）；坐标 delta 用两点法（cssToPage 前后差），
 *   旋转/scale 自动对易，本层不做坐标算术。
 *
 * @see [架构方案 §6.3/§6.5](../../../docs/插件开发/PDF编辑器-架构方案.md)
 */
(function (global) {
  'use strict';

  var PDFED = global.PDFED = global.PDFED || {};
  var G = PDFED.geometry;
  var M = PDFED.model;
  var C = PDFED.commands;

  var MIN_DRAW_PT = 8;          // 绘制最小尺寸，防误点
  var SNAP_PT = 8;              // 页边吸附阈值（pt）
  var KEY_MOVE_PT = 1, KEY_MOVE_BIG_PT = 10;

  function createInteract(opts) {
    var renderer = opts.renderer;
    var store = opts.store;
    var history = opts.history;
    var scrollEl = opts.scrollEl;
    var doc = opts.document;
    var toast = opts.toast || function () {};
    var onBeforeCommand = opts.onBeforeCommand || function () {};
    var drag = null;                          // 活动拖拽状态
    var draft = null;                         // 草稿对象引用（shell 注入，id 分配用）

    /* ── 指针 ── */

    function pageCtxOfOverlay(o) {
      var idx = renderer.orderIndexOf(o.pageId);
      return idx < 0 ? null : renderer.pageCtxOf(idx);
    }

    function overlayFromEvent(e) {
      var el = e.target.closest && e.target.closest('[data-ov-id]');
      if (!el) return null;
      var o = store.overlayById(el.dataset.ovId);
      return o ? { o: o, el: el } : null;
    }

    function onPointerDown(e) {
      if (renderer.isGesture() || !store.get().doc) return;
      if (e.button !== 0) return;
      /* 就地编辑中：点编辑框内交给浏览器光标；点外部先提交再继续选择/拖拽 */
      if (editing) {
        if (editing.box.contains(e.target)) return;
        exitTextEdit(true);
      }
      var handle = e.target.closest && e.target.closest('.ov-handle');
      if (handle) {
        var id = handle.closest('.ov-handles').dataset.handleFor;
        var o = store.overlayById(id);
        if (!o) return;
        drag = {
          kind: 'resize', handle: handle.dataset.handle, o: o,
          ctx: pageCtxOfOverlay(o),
          startCss: G.rectPageToCss({ x: o.x, y: o.y, w: o.w, h: o.h }, pageCtxOfOverlay(o)),
          startX: e.clientX, startY: e.clientY
        };
        e.preventDefault();
        return;
      }
      var hit = overlayFromEvent(e);
      if (hit) {
        var already = store.get().selection.indexOf(hit.o.id) >= 0;
        if (!already) store.change('selection-set', { ids: [hit.o.id] });
        var ctx = pageCtxOfOverlay(hit.o);
        var start = screenPointInPage(e, hit.o.pageId);
        drag = {
          kind: 'move', o: hit.o, el: hit.el, ctx: ctx,
          startX: e.clientX, startY: e.clientY,          // 缺失则 dx=NaN：拖动即坐标污染
          startPagePt: G.pointCssToPage(start.px, start.py, ctx),
          moved: false, dx: 0, dy: 0
        };
        e.preventDefault();
        return;
      }
      /* 空白处：绘制模式拖拽建对象；否则清选中 */
      var mode = store.get().mode;
      if (mode === 'text' || mode === 'whiteout' || mode === 'highlight') {
        var activePageId = store.get().activePageId;
        if (!activePageId) return;
        var ctx2 = renderer.pageCtxOf(renderer.orderIndexOf(activePageId));
        var sp = screenPointInPage(e, activePageId);
        if (!sp) return;
        drag = { kind: 'draw', mode: mode, ctx: ctx2, pageId: activePageId, startScreen: sp, startPagePt: G.pointCssToPage(sp.px, sp.py, ctx2), ghost: makeGhost(activePageId) };
        e.preventDefault();
      } else if (store.get().selection.length) {
        store.change('selection-set', { ids: [] });
      }
    }

    function screenPointInPage(e, pageId) {
      var frame = renderer.frameOf(pageId);
      if (!frame) return null;
      var r = frame.getBoundingClientRect();
      return { px: e.clientX - r.left, py: e.clientY - r.top };
    }

    function makeGhost(pageId) {
      var layer = renderer.overlayLayerOf(pageId);
      if (!layer) return null;
      var ghost = doc.createElement('div');
      ghost.className = 'ov-ghost';
      layer.appendChild(ghost);
      return ghost;
    }

    function onPointerMove(e) {
      if (!drag) return;
      var dx = e.clientX - (drag.startX || e.clientX);
      var dy = e.clientY - (drag.startY || e.clientY);
      if (drag.kind === 'move') {
        drag.dx = e.clientX - drag.startX; drag.dy = e.clientY - drag.startY;
        if (Math.abs(drag.dx) + Math.abs(drag.dy) > 2) drag.moved = true;
        drag.el.style.transform = 'translate(' + drag.dx + 'px,' + drag.dy + 'px)';
      } else if (drag.kind === 'resize') {
        drag.curCss = resizeCss(drag, e);
        applyCssRect(drag.el, drag.curCss);
      } else if (drag.kind === 'draw') {
        var cur = G.pointCssToPage(
          screenPointInPage(e, store.get().activePageId).px,
          screenPointInPage(e, store.get().activePageId).py, drag.ctx);
        var rect = G.normalizeRect(drag.startPagePt.x, drag.startPagePt.y, cur.x, cur.y);
        var css = G.rectPageToCss(rect, drag.ctx);
        drag.ghost.style.left = css.px + 'px';
        drag.ghost.style.top = css.py + 'px';
        drag.ghost.style.width = css.w + 'px';
        drag.ghost.style.height = css.h + 'px';
        drag.curRect = rect;
      }
    }

    function resizeCss(drag, e) {
      var dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      var s = drag.startCss, h = drag.handle;
      var x1 = s.px, y1 = s.py, x2 = s.px + s.w, y2 = s.py + s.h;
      if (h.indexOf('w') >= 0) x1 = Math.min(x1 + dx, x2 - 8);
      if (h.indexOf('e') >= 0) x2 = Math.max(x2 + dx, x1 + 8);
      if (h.indexOf('n') >= 0) y1 = Math.min(y1 + dy, y2 - 8);
      if (h.indexOf('s') >= 0) y2 = Math.max(y2 + dy, y1 + 8);
      return { px: x1, py: y1, w: x2 - x1, h: y2 - y1 };
    }

    function applyCssRect(el, r) {
      el.style.left = r.px + 'px';
      el.style.top = r.py + 'px';
      el.style.width = r.w + 'px';
      el.style.height = r.h + 'px';
    }

    function snapPage(rect, ctx) {
      /* 页边吸附：左/右/上下缘接近 0 或页尺寸时吸附（pt） */
      var snapped = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      if (Math.abs(rect.x) < SNAP_PT) snapped.x = 0;
      if (Math.abs(rect.y) < SNAP_PT) snapped.y = 0;
      if (Math.abs(rect.x + rect.w - ctx.cropW) < SNAP_PT) snapped.x = ctx.cropW - rect.w;
      if (Math.abs(rect.y + rect.h - ctx.cropH) < SNAP_PT) snapped.y = ctx.cropH - rect.h;
      return snapped;
    }

    function onPointerUp(e) {
      if (!drag) return;
      var d = drag;
      drag = null;
      if (d.kind === 'move') {
        d.el.style.transform = '';
        if (!d.moved) return;                    // 纯点击：仅选中
        /* delta 经两点法换存储 pt（旋转下自动对易），吸附后 clamp 落库 */
        var startPx = { px: 0, py: 0 };
        var p0 = G.pointCssToPage(startPx.px, startPx.py, d.ctx);
        var p1 = G.pointCssToPage(startPx.px + d.dx, startPx.py + d.dy, d.ctx);
        var nx = d.o.x + (p1.x - p0.x), ny = d.o.y + (p1.y - p0.y);
        var rect = G.clampRectToPage({ x: nx, y: ny, w: d.o.w, h: d.o.h }, d.ctx);
        rect = snapPage(rect, d.ctx);
        if (Math.abs(rect.x - d.o.x) < 0.01 && Math.abs(rect.y - d.o.y) < 0.01) return;
        var before = { x: d.o.x, y: d.o.y };
        var after = { x: round2(rect.x), y: round2(rect.y) };
        store.change('overlay-update', { id: d.o.id, patch: after });
        history.push(C.updateOverlay(store, d.o.id, before, after, '移动'));
      } else if (d.kind === 'resize') {
        d.el.style.transform = '';
        var prect = G.rectCssToPage(d.curCss, d.ctx);
        prect = G.clampRectToPage(prect, d.ctx);
        prect = snapPage(prect, d.ctx);
        var b = { x: d.o.x, y: d.o.y, w: d.o.w, h: d.o.h };
        var a = { x: round2(prect.x), y: round2(prect.y), w: round2(prect.w), h: round2(prect.h) };
        if (sameRect(b, a)) {
          if (overlayView) overlayView.syncPage(d.o.pageId);   // 未变化：还原显示
          return;
        }
        store.change('overlay-update', { id: d.o.id, patch: a });
        history.push(C.updateOverlay(store, d.o.id, b, a, '调整大小'));
      } else if (d.kind === 'draw') {
        if (d.ghost) d.ghost.remove();
        var endSp = screenPointInPage(e, store.get().activePageId);
        var dragPx = endSp && d.startScreen
          ? Math.abs(endSp.px - d.startScreen.px) + Math.abs(endSp.py - d.startScreen.py) : 999;
        /* 白盒工具单击（几乎无位移）：点击原文 → 自动白盒 + 预填文本改写 */
        if (dragPx < 6 && d.mode === 'whiteout' && opts.probeTextAt) {
          probeWhiteout(d.pageId, d.startPagePt);
          return;
        }
        var rect = d.curRect && d.curRect.w >= MIN_DRAW_PT && d.curRect.h >= MIN_DRAW_PT
          ? G.clampRectToPage(snapPage(d.curRect, d.ctx), d.ctx) : null;
        if (!rect) { if (overlayView) overlayView.syncPage(store.get().activePageId); return; }
        createByMode(d.mode, rect, d.ctx);
      }
    }

    function snapPage(rect, ctx) {
      var s = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      if (Math.abs(rect.x) < SNAP_PT) s.x = 0;
      if (Math.abs(rect.y) < SNAP_PT) s.y = 0;
      if (Math.abs(rect.x + rect.w - ctx.cropW) < SNAP_PT) s.x = ctx.cropW - rect.w;
      if (Math.abs(rect.y + rect.h - ctx.cropH) < SNAP_PT) s.y = ctx.cropH - rect.h;
      return s;
    }
    function round2(v) { return Math.round(v * 100) / 100; }
    function sameRect(a, b) {
      return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 &&
        Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01;
    }

    /* ── 绘制创建 ── */

    /** 白盒工具单击原文：自动白盒遮盖 + 预填文本框（架构 P0 功能 4）。
     *  白盒与预填文本框是一个撤销单元（改写原文）；预填位置是建议值
     *  （架构 R2：CJK 偏移风险，用户可拖正），进编辑态即改。 */
    function probeWhiteout(pageId, localPt) {
      opts.probeTextAt(pageId, localPt).then(function (hit) {
        if (!store.get().doc) return;
        if (!hit) { toast('此处未找到文字，可拖拽绘制白盒'); return; }
        var z = store.topZ(pageId) + 1;
        var wo = M.makeWhiteout(pageId, hit.rect, z);
        wo.id = M.nextId(store.get(), 'ov');
        var to = M.makeOverlay('text', {
          pageId: pageId, x: hit.rect.x, y: hit.rect.y, w: hit.rect.w, h: hit.rect.h, z: z + 1,
          text: { value: hit.text, fontSize: hit.fontSize, lines: null }
        });
        to.id = M.nextId(store.get(), 'ov');
        var woSnap = M.clone(wo), toSnap = M.clone(to);
        store.change('overlay-add', { overlay: wo, asset: null });
        store.change('overlay-add', { overlay: to, asset: null });
        history.push({
          label: '改写原文',
          do: function () {
            store.change('overlay-add', { overlay: M.clone(woSnap), asset: null });
            store.change('overlay-add', { overlay: M.clone(toSnap), asset: null });
          },
          undo: function () {
            store.change('overlay-remove', { id: woSnap.id });
            store.change('overlay-remove', { id: toSnap.id });
          }
        });
        store.change('selection-set', { ids: [to.id] });
        store.change('meta', { patch: { mode: 'view' } });
        enterTextEdit(to);
      }, function () { toast('原文定位失败，可拖拽绘制白盒'); });
    }

    function createByMode(mode, rect, ctx) {
      var pageId = store.get().activePageId;
      var o;
      var z = store.topZ(pageId) + 1;
      if (mode === 'text') {
        o = M.makeOverlay('text', { pageId: pageId, x: rect.x, y: rect.y, w: rect.w, h: Math.max(rect.h, 20), z: z });
        o.text.fontSize = G.lenCssToPage(14, ctx) || 12;
      } else if (mode === 'whiteout') {
        o = M.makeWhiteout(pageId, rect, z);
      } else if (mode === 'highlight') {
        o = M.makeHighlight(pageId, rect, z);
      } else return;
      o.id = M.nextId(store.get(), 'ov');
      var cmd = C.addOverlay(store, o, null);
      store.change('overlay-add', { overlay: o, asset: null });
      history.push(cmd);
      store.change('selection-set', { ids: [o.id] });
      store.change('meta', { patch: { mode: 'view' } });
      if (mode === 'text') enterTextEdit(o);      // 新文本框立即进入编辑
    }

    /* ── 就地文本编辑 + 行烘焙 ── */

    var editing = null;                          // { id, box, o }

    function enterTextEdit(o) {
      var layer = renderer.overlayLayerOf(o.pageId);
      var el = layer && layer.querySelector('[data-ov-id="' + o.id + '"]');
      var box = el && el.querySelector('.ov-text');
      if (!box || editing) return;
      editing = { id: o.id, box: box, o: o };
      box.contentEditable = 'plaintext-only';
      box.classList.add('editing');
      overlayView && overlayView.setEditing(o.id);
      /* 失焦即提交（真机 P0 修复：没有 blur 提交，用户打字全部丢失——
       * 「编辑不了」的主感受来源；once：exitTextEdit 内部触发 blur 时不再递归） */
      box.addEventListener('blur', function () { exitTextEdit(true); }, { once: true });
      box.focus();
      doc.getSelection().selectAllChildren(box);
      onBeforeCommand && onBeforeCommand('edit-start');
    }
    var overlayView = null;
    function bindOverlayView(v) { overlayView = v; }

    function exitTextEdit(commit) {
      if (!editing) return;
      var ctx = editing;
      editing = null;
      ctx.box.contentEditable = 'false';
      ctx.box.classList.remove('editing');
      overlayView && overlayView.setEditing(null);
      var o = store.overlayById(ctx.id);
      if (!o) return;
      var value = ctx.box.textContent || '';
      var lines = commit ? bakeLines(ctx.box, ctx.o) : null;
      var before = { text: { value: o.text.value, lines: o.text.lines } };
      var after = { text: { value: value, lines: lines } };
      var changed = value !== o.text.value || JSON.stringify(lines) !== JSON.stringify(o.text.lines);
      if (commit && changed) {
        store.change('overlay-update', { id: o.id, patch: after });
        history.push(C.updateOverlay(store, o.id, before, after, '编辑文本'));
      } else if (!commit) {
        syncPageOf(o.pageId);                    // 还原显示
      }
      onBeforeCommand && onBeforeCommand('edit-end');
    }

    function syncPageOf(pageId) { if (overlayView) overlayView.syncPage(pageId); }

    /**
     * 行烘焙（架构 ADR-8）：失焦提交时用 Range API 逐字符扫行盒，检测换行点，
     * 每行烘 {text, x, baseY}（存储 pt，基线 = 行盒顶 + 0.8em 近似）；导出端
     * 零排版逻辑。旋转页行盒仍水平（frame DOM 不旋转），近似成立。
     */
    function bakeLines(box, o) {
      var ctx = pageCtxOfOverlay(o);
      var frame = renderer.frameOf(o.pageId);
      if (!frame || !ctx) return null;
      var frameRect = frame.getBoundingClientRect();
      var node = box.firstChild;
      var s = (node && node.nodeType === 3) ? node.textContent : (box.textContent || '');
      if (!s) return [];
      var range = doc.createRange();
      var lines = [];
      var lineStart = 0;
      var prevTop = null;
      var prevRect = null;

      function emit(text, r) {
        if (!text || !r) return;
        var px = r.left - frameRect.left;
        var baselinePy = r.top - frameRect.top + r.height * 0.8;   // 基线近似
        var p = G.pointCssToPage(px, baselinePy, ctx);
        lines.push({ text: text, x: Math.round(p.x * 100) / 100, baseY: Math.round(p.y * 100) / 100 });
      }

      for (var i = 0; i < s.length; i++) {
        range.setStart(node, i);
        range.setEnd(node, Math.min(s.length, i + 1));
        var rects = range.getClientRects();
        if (!rects.length) continue;
        var r = rects[0];
        if (prevTop !== null && r.top - prevTop > 1) {             // 换行
          emit(s.slice(lineStart, i), prevRect);
          lineStart = i;
        }
        prevTop = r.top;
        prevRect = r;
      }
      if (prevRect) emit(s.slice(lineStart), prevRect);
      return lines;
    }

    /* ── 快捷键（集中键表，单一分发器） ── */

    /* 加固裁决已由 shell 完成（capture 最先）；本表全部是加固不碰的键。
     * redo 刻意不用 Ctrl+R：对象选中时焦点不在编辑框，Ctrl+R 必撞加固拦截（ADR-9）。 */
    var SHORTCUTS = [
      { key: 'Delete', when: 'canvas', action: 'delete-selection' },
      { key: 'Backspace', when: 'canvas', action: 'delete-selection' },
      { key: 'Escape', when: 'any', action: 'escape' },
      { key: 'z', ctrl: true, when: 'canvas', action: 'undo' },
      { key: 'y', ctrl: true, when: 'canvas', action: 'redo' },
      { key: 'z', ctrl: true, shift: true, when: 'canvas', action: 'redo' },
      { key: 'd', ctrl: true, when: 'canvas', action: 'duplicate' },
      { key: 'a', ctrl: true, when: 'canvas', action: 'select-all' },
      { key: 'ArrowLeft', when: 'canvas', action: 'nudge-left' },
      { key: 'ArrowRight', when: 'canvas', action: 'nudge-right' },
      { key: 'ArrowUp', when: 'canvas', action: 'nudge-up' },
      { key: 'ArrowDown', when: 'canvas', action: 'nudge-down' },
      { key: ']', when: 'canvas', action: 'bring-forward' },
      { key: '[', when: 'canvas', action: 'send-backward' },
      { key: '=', ctrl: true, when: 'any', action: 'zoom-in' },
      { key: '+', ctrl: true, when: 'any', action: 'zoom-in' },
      { key: '-', ctrl: true, when: 'any', action: 'zoom-out' },
      { key: '0', ctrl: true, when: 'any', action: 'zoom-fit' }
    ];

    function editingFocus(el) {
      return !!(el && el.closest && el.closest('[contenteditable="plaintext-only"], input, textarea'));
    }

    function onKeydown(e) {
      var inEdit = editingFocus(e.target);
      if (inEdit) {
        if (e.key === 'Escape') { exitTextEdit(true); e.preventDefault(); }
        /* 编辑焦点内只放行文本类操作（浏览器默认），对象类快捷键不放行 */
        return;
      }
      for (var i = 0; i < SHORTCUTS.length; i++) {
        var sc = SHORTCUTS[i];
        if (sc.key.toLowerCase() !== (e.key || '').toLowerCase()) continue;
        if (!!sc.ctrl !== (e.ctrlKey || e.metaKey)) continue;
        if (!!sc.shift !== e.shiftKey) continue;
        if (sc.when === 'canvas' && !store.get().doc) continue;
        if (runAction(sc.action, e)) { e.preventDefault(); return; }
      }
    }

    function runAction(name, e) {
      var sel = store.get().selection;
      var o = sel.length ? store.overlayById(sel[0]) : null;
      switch (name) {
        case 'delete-selection':
          if (!o) return false;
          store.change('overlay-remove', { id: o.id });
          history.push(C.removeOverlay(store, o));
          return true;
        case 'escape':
          if (editing) { exitTextEdit(true); return true; }
          if (sel.length) { store.change('selection-set', { ids: [] }); return true; }
          return false;
        case 'undo': history.undo(); return true;
        case 'redo': history.redo(); return true;
        case 'duplicate': if (o) duplicate(o); return !!o;
        case 'select-all':
          var pageId = store.get().activePageId;
          var ids = store.overlaysOfPage(pageId).map(function (x) { return x.id; });
          if (ids.length) store.change('selection-set', { ids: ids });
          return ids.length > 0;
        case 'nudge-left': case 'nudge-right': case 'nudge-up': case 'nudge-down':
          if (!o) return false;
          nudge(o, name, e.shiftKey ? KEY_MOVE_BIG_PT : KEY_MOVE_PT);
          return true;
        case 'bring-forward': case 'send-backward':
          if (!o) return false;
          reorderZ(o, name === 'bring-forward' ? 1 : -1);
          return true;
        case 'zoom-in': opts.zoom(1.2); return true;
        case 'zoom-out': opts.zoom(1 / 1.2); return true;
        case 'zoom-fit': opts.zoomFit(); return true;
        default: return false;
      }
    }

    function nudge(o, name, step) {
      var ctx = pageCtxOfOverlay(o);
      var dx = 0, dy = 0;
      /* 方向键跟随视觉：旋转页下由两点法换算保持直觉方向 */
      var base = G.pointCssToPage(0, 0, ctx);
      var target = null;
      if (name === 'nudge-left') target = G.pointCssToPage(-step * ctx.scale, 0, ctx);
      if (name === 'nudge-right') target = G.pointCssToPage(step * ctx.scale, 0, ctx);
      if (name === 'nudge-up') target = G.pointCssToPage(0, -step * ctx.scale, ctx);
      if (name === 'nudge-down') target = G.pointCssToPage(0, step * ctx.scale, ctx);
      var before = { x: o.x, y: o.y };
      var after = G.clampRectToPage({ x: o.x + (target.x - base.x), y: o.y + (target.y - base.y), w: o.w, h: o.h }, ctx);
      after = { x: round2(after.x), y: round2(after.y) };
      if (after.x === o.x && after.y === o.y) return;
      store.change('overlay-update', { id: o.id, patch: after });
      history.push(C.updateOverlay(store, o.id, before, after, '微移'));
    }

    function reorderZ(o, dir) {
      var items = store.overlaysOfPage(o.pageId);
      var idx = items.findIndex(function (x) { return x.id === o.id; });
      var to = idx + dir;
      if (to < 0 || to >= items.length) return;
      var newZs = items.map(function (x) { return x.z; });
      var tmp = newZs[idx]; newZs[idx] = newZs[to]; newZs[to] = tmp;
      var before = items.reduce(function (acc, x) { acc[x.id] = x.z; return acc; }, {});
      store.change('overlay-update', { id: o.id, patch: { z: newZs[to] } });
      store.change('overlay-update', { id: items[to].id, patch: { z: newZs[idx] } });
      history.push({
        label: '调整层级',
        do: function () {
          store.change('overlay-update', { id: o.id, patch: { z: newZs[to] } });
          store.change('overlay-update', { id: items[to].id, patch: { z: newZs[idx] } });
        },
        undo: function () {
          Object.keys(before).forEach(function (id) {
            store.change('overlay-update', { id: id, patch: { z: before[id] } });
          });
        }
      });
    }

    function duplicate(o) {
      var copy = M.clone(o);
      copy.id = M.nextId(store.get(), 'ov');
      copy.z = store.topZ(o.pageId) + 1;
      copy.x += 10; copy.y -= 10;
      if (copy.text) { copy.text = M.clone(copy.text); copy.text.lines = null; }
      var cmd = C.addOverlay(store, copy, null);
      store.change('overlay-add', { overlay: copy, asset: null });
      history.push(cmd);
      store.change('selection-set', { ids: [copy.id] });
    }

    /* ── 生命周期与装配 ── */

    function attach() {
      scrollEl.addEventListener('pointerdown', onPointerDown);
      doc.addEventListener('pointermove', onPointerMove);
      doc.addEventListener('pointerup', onPointerUp);
      doc.addEventListener('keydown', onKeydown);
      scrollEl.addEventListener('dblclick', onDblclick);
    }
    function onDblclick(e) {
      var hit = overlayFromEvent(e);
      if (hit && hit.o.type === 'text') { enterTextEdit(hit.o); e.preventDefault(); }
    }

    return {
      attach: attach,
      bindOverlayView: bindOverlayView,
      enterTextEdit: enterTextEdit,
      exitTextEdit: exitTextEdit,
      isEditing: function () { return !!editing; },
      createByMode: createByMode
    };
  }

  PDFED.interact = { createInteract: createInteract };
})(typeof window !== 'undefined' ? window : globalThis);