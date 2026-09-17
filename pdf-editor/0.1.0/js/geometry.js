/* geometry.js — 坐标换算唯一权威（纯函数，Node 可测）
 *
 * 坐标系拍板（架构 ADR-2，M4 冒烟对拍 pdf.js 真实变换已验证）：
 * - 存储（唯一权威）= 未旋转 CropBox 局部空间：pt，原点 = CropBox 左下角，Y 向上。
 *   即 lx ∈ [0, cropW]，ly ∈ [0, cropH]；矩形 {x,y,w,h} 的 (x,y) 是左下角。
 *   注意：存储 x 不含 CropBox 绝对偏移（cropX 只在 toPdfLib* 导出时加回）。
 * - 视图（临时值）= pdf.js viewport CSS 像素：Y 向下，含页旋转（/Rotate + rotateDelta）与 scale。
 *   pdf.js viewport 变换天然以 view（CropBox）原点为屏幕原点：vx = lx·s ——
 *   与局部语义严格对齐（export-smoke 四象限对拍 + ≤1pt 容差为门禁）。
 *   交互事件进来立刻经 pointCssToPage 落库；渲染经 pointPageToCss 出去。
 * - 除本文件外任何模块禁止出现乘除 scale 的坐标算术（code review 一票项）。
 *
 * 旋转推导（rot90 = 顺时针，屏幕宽高对易）：
 *   屏幕坐标（Y 向下）与局部坐标（Y 向上）四象限：
 *     rot 0:   px = lx·s         py = (ch − ly)·s     （屏宽=cw·s，屏高=ch·s）
 *     rot 90:  px = ly·s         py = lx·s            （顺时针；屏宽=ch·s，屏高=cw·s）
 *     rot 180: px = (cw − lx)·s  py = ly·s
 *     rot 270: px = (ch − ly)·s  py = (cw − lx)·s
 *
 * @see [架构方案 §5.1](../../../docs/插件开发/PDF编辑器-架构方案.md)
 * @see [决策笔记 2026-09-17-pdf-editor-design](../../../.agents/notes/implemented/architecture/2026-09-17-pdf-editor-design.md)
 *
 * 本文件不依赖 DOM/vendor 全局做顶层初始化，可在 Node 沙箱加载。
 */
(function (global) {
  'use strict';

  var PDFED = global.PDFED = global.PDFED || {};

  /** 旋转角归一到 0/90/180/270；非法值取 0（宽容输入，页面级旋转只会产生这四个值）。 */
  function normRotation(deg) {
    var r = ((Math.round(Number(deg) || 0) % 360) + 360) % 360;
    return (r === 90 || r === 180 || r === 270) ? r : 0;
  }

  /**
   * 换算上下文：每页构建一次，渲染层与编辑层共享。
   * @param {object} opts { cropX, cropY, cropW, cropH, scale, rotation }
   *   cropX/cropY = CropBox 原点（pt，来自 pdf.js page.view 左下角）；
   *   cropW/cropH = CropBox 宽高（pt，pdf.js page.view[2]-view[0] 等）；
   *   rotation = viewport 总旋转（页 /Rotate + rotateDelta），内部归一。
   */
  function makePageCtx(opts) {
    var cw = Number(opts.cropW), ch = Number(opts.cropH);
    if (!(cw > 0) || !(ch > 0)) throw new Error('geometry: 非法页尺寸 cropW/cropH=' + cw + '/' + ch);
    var s = opts.scale == null ? 1 : Number(opts.scale);
    if (!(s > 0) || !isFinite(s)) throw new Error('geometry: 非法 scale=' + s);
    var rot = normRotation(opts.rotation || 0);
    return {
      cropX: Number(opts.cropX) || 0,
      cropY: Number(opts.cropY) || 0,
      cropW: cw,
      cropH: ch,
      scale: s,
      rotation: rot,
      /* 页面在屏幕上的 CSS 尺寸（90/270 时对易） */
      viewW: (rot === 90 || rot === 270 ? ch : cw) * s,
      viewH: (rot === 90 || rot === 270 ? cw : ch) * s
    };
  }

  /** 存储 pt（未旋转局部空间，Y 向上）→ 视图 px（Y 向下，含旋转/scale）。 */
  function pointPageToCss(x, y, ctx) {
    var lx = x, ly = y, s = ctx.scale;
    var px, py;
    switch (ctx.rotation) {
      case 90: px = ly * s; py = lx * s; break;
      case 180: px = (ctx.cropW - lx) * s; py = ly * s; break;
      case 270: px = (ctx.cropH - ly) * s; py = (ctx.cropW - lx) * s; break;
      default: px = lx * s; py = (ctx.cropH - ly) * s; break;
    }
    return { px: px, py: py };
  }

  /** 视图 px → 存储 pt（局部空间）。与 pointPageToCss 严格互逆。 */
  function pointCssToPage(px, py, ctx) {
    var s = ctx.scale, lx, ly;
    switch (ctx.rotation) {
      case 90: ly = px / s; lx = py / s; break;
      case 180: lx = ctx.cropW - px / s; ly = py / s; break;
      case 270: ly = ctx.cropH - px / s; lx = ctx.cropW - py / s; break;
      default: lx = px / s; ly = ctx.cropH - py / s; break;
    }
    return { x: lx, y: ly };
  }

  /**
   * 存储矩形 → 视图矩形。四角变换后取包围盒：任意旋转象限统一处理，
   * 90/270 时宽高对易自动成立，不做角落公式特判。
   * 入参/出参矩形均为 {x,y,w,h}（各自身份空间内的左上角对应物——存储空间
   * 的 y 是矩形底边，输出 py 是屏幕顶边，由 Y 翻转自然产生）。
   */
  function rectPageToCss(r, ctx) {
    var c1 = pointPageToCss(r.x, r.y, ctx);
    var c2 = pointPageToCss(r.x + r.w, r.y, ctx);
    var c3 = pointPageToCss(r.x, r.y + r.h, ctx);
    var c4 = pointPageToCss(r.x + r.w, r.y + r.h, ctx);
    var minX = Math.min(c1.px, c2.px, c3.px, c4.px);
    var maxX = Math.max(c1.px, c2.px, c3.px, c4.px);
    var minY = Math.min(c1.py, c2.py, c3.py, c4.py);
    var maxY = Math.max(c1.py, c2.py, c3.py, c4.py);
    return { px: minX, py: minY, w: maxX - minX, h: maxY - minY };
  }

  /** 视图矩形 → 存储矩形（同样四角法；逆旋转下严格互逆）。 */
  function rectCssToPage(r, ctx) {
    var p1 = pointCssToPage(r.px, r.py, ctx);
    var p2 = pointCssToPage(r.px + r.w, r.py, ctx);
    var p3 = pointCssToPage(r.px, r.py + r.h, ctx);
    var p4 = pointCssToPage(r.px + r.w, r.py + r.h, ctx);
    var minX = Math.min(p1.x, p2.x, p3.x, p4.x);
    var maxX = Math.max(p1.x, p2.x, p3.x, p4.x);
    var minY = Math.min(p1.y, p2.y, p3.y, p4.y);
    var maxY = Math.max(p1.y, p2.y, p3.y, p4.y);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /** 存储空间两点归一为规范矩形（拖拽起止点 → {x,y,w,h}，w/h ≥ 0）。 */
  function normalizeRect(ax, ay, bx, by) {
    return {
      x: Math.min(ax, bx),
      y: Math.min(ay, by),
      w: Math.abs(bx - ax),
      h: Math.abs(by - ay)
    };
  }

  /** 长度换算：pt → px / px → pt（一维，无对易）。字号等标量用。 */
  function lenPageToCss(len, ctx) { return len * ctx.scale; }
  function lenCssToPage(len, ctx) { return len / ctx.scale; }

  /**
   * 导出偏移：存储（CropBox 局部）→ pdf-lib 绘制空间（未旋转用户空间绝对坐标）。
   * 导出端经此取坐标，自己不做坐标算术；旋转交给 page.setRotation（页面属性，
   * 内容流坐标不变），冒烟矩阵必须含 CropBox≠MediaBox 用例验证本换算。
   */
  function toPdfLibPoint(x, y, ctx) {
    return { x: x + ctx.cropX, y: y + ctx.cropY };
  }
  function toPdfLibRect(r, ctx) {
    return { x: r.x + ctx.cropX, y: r.y + ctx.cropY, w: r.w, h: r.h };
  }

  /** 存储矩形夹回页内（局部空间 [0,cw]×[0,ch]；w/h 保底 1pt 防退化）。 */
  function clampRectToPage(r, ctx) {
    var w = Math.max(1, Math.min(r.w, ctx.cropW));
    var h = Math.max(1, Math.min(r.h, ctx.cropH));
    var x = Math.min(Math.max(r.x, 0), ctx.cropW - w);
    var y = Math.min(Math.max(r.y, 0), ctx.cropH - h);
    return { x: x, y: y, w: w, h: h };
  }

  /** 两矩形（同一空间）是否相交（命中/吸附用，不含边界相切）。 */
  function rectsIntersect(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w &&
           a.y < b.y + b.h && b.y < a.y + a.h;
  }

  PDFED.geometry = {
    normRotation: normRotation,
    makePageCtx: makePageCtx,
    pointPageToCss: pointPageToCss,
    pointCssToPage: pointCssToPage,
    rectPageToCss: rectPageToCss,
    rectCssToPage: rectCssToPage,
    normalizeRect: normalizeRect,
    lenPageToCss: lenPageToCss,
    lenCssToPage: lenCssToPage,
    toPdfLibPoint: toPdfLibPoint,
    toPdfLibRect: toPdfLibRect,
    clampRectToPage: clampRectToPage,
    rectsIntersect: rectsIntersect
  };
})(typeof window !== 'undefined' ? window : globalThis);