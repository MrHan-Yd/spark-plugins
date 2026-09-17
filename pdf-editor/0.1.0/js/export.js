/* export.js — pdf-lib 导出合成管线（页面结构 + 覆盖物烧录 + 行烘焙绘制，Node 可测）
 *
 * 约定（架构 §7.2/ADR-1/ADR-5/ADR-8）：
 * - 覆盖式导出：原内容不动（copyPages 自身），只烧录覆盖物；页序/旋转是
 *   页面属性（setRotation），内容流坐标不变。
 * - 坐标：存储（CropBox 局部 pt）经 geometry.toPdfLibPoint/toPdfLibRect 加回
 *   CropBox 原点 → pdf-lib 用户空间绝对坐标；本文件不做其它坐标换算。
 * - 行烘焙 lines 是文本唯一权威（编辑失焦时烘焙）；导出端零排版逻辑；
 *   lines 缺失仅单行兜底（与编辑态换行可能不一致，属降级路径）。
 * - 缺字行（生僻字/emoji 超出预子集）：调用方注入 rasterizeLine 回调，
 *   canvas 栅格化 PNG 烧录（内容不丢、如实降级）；未注入则跳过并警示。
 * - 字体：预子集 Noto Sans SC TTF（Regular 已固化），embedFont({subset:true})
 *   每文档一份，随文档丢弃；子集化翻车降级整字体嵌入（Plan B）。
 * - burnOverlay 全 async：pdf-lib 的 embed* 返回 Promise，必须 await 后再
 *   save，否则绘制发生在序列化之后静默丢失（本项目实测过的时序坑）。
 *
 * @see [架构方案 §7](../../../docs/插件开发/PDF编辑器-架构方案.md)
 *
 * 本文件不依赖 DOM/vendor 全局做顶层初始化；PDFLib/fontkit 由调用方注入，
 * 可在 Node 沙箱加载（toolkit engine.js 先例）。
 */
(function (global) {
  'use strict';

  var PDFED = global.PDFED = global.PDFED || {};
  var G = PDFED.geometry;

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    var v = parseInt(m[1], 16);
    return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
  }

  /** 行文本字形探测：返回缺失字符数组（.notdef 计）。 */
  function missingGlyphs(font, text) {
    var miss = [];
    try {
      var glyphs = font.glyphsForString(text);
      for (var i = 0; i < glyphs.length; i++) {
        if (!glyphs[i] || glyphs[i].id === 0) miss.push(text[i]);
      }
    } catch (e) { return [text]; }
    return miss;
  }

  /**
   * 导出：Draft 数据 + 原始字节 → 新 PDF（Uint8Array）。
   * @param {object} opts {
   *   bytes 原始 PDF；pages/overlays/assets 按 model schema；
   *   fontBytes 预子集中文字体（可空）；PDFLib/fontkit 注入；
   *   rasterizeLine(text, style) → Promise<{bytes, wPt, hPt} | null>（可选，缺字降级）
   * }
   * @returns {Promise<{bytes, mime, warnings: string[]}>}
   */
  async function exportPdf(opts) {
    var PDFLib = opts.PDFLib || global.PDFLib;
    if (!PDFLib) throw new Error('export: 缺少 PDFLib');
    var fontkit = opts.fontkit || global.fontkit;
    var pages = opts.pages || [];
    var overlays = opts.overlays || [];
    var assets = opts.assets || {};
    var warnings = [];

    /* 源文档（只读，供 copyPages）与输出文档（新建，页序重建）分离：
     * pdf-lib copyPages 是跨文档语义，同实例自复制会保留原页并翻倍总页数 */
    var srcDoc;
    try {
      srcDoc = await PDFLib.PDFDocument.load(opts.bytes);
    } catch (e) {
      throw new Error('文档无法读取（可能已加密或损坏）：' + ((e && e.message) || e));
    }
    var outDoc = await PDFLib.PDFDocument.create();

    /* 字体：绘制用 pdf-lib PDFFont；字形探测用 fontkit 原始 Font（PDFFont 无
     * glyphsForString）。每文档会话一份缓存，随文档丢弃；不缓存跨文档实例 */
    var font = null, kfFont = null;
    if (opts.fontBytes && opts.fontBytes.length) {
      if (!fontkit) throw new Error('export: 缺少 fontkit（中文字体嵌入必需）');
      outDoc.registerFontkit(fontkit);
      try {
        font = await outDoc.embedFont(opts.fontBytes, { subset: true });
      } catch (e) {
        /* R6 Plan B：整字体嵌入不子集 */
        font = await outDoc.embedFont(opts.fontBytes, { subset: false });
        warnings.push('字体子集化失败已降级整字体嵌入');
      }
      try { kfFont = fontkit.create(opts.fontBytes); } catch (e) { kfFont = null; }
    }

    /* ── 页面结构：copyPages 跨实例按模型页序重建（支持重排/删除/复制/空白页） ── */
    var outPageMap = {};
    for (var pi = 0; pi < pages.length; pi++) {
      var mp = pages[pi];
      var page;
      if (mp.srcIndex != null) {
        var copied = await outDoc.copyPages(srcDoc, [mp.srcIndex]);
        page = outDoc.addPage(copied[0]);
      } else {
        page = outDoc.addPage([595.28, 841.89]);
      }
      outPageMap[mp.id] = page;
      var orig = page.getRotation().angle || 0;
      if (mp.rotateDelta) {
        page.setRotation(PDFLib.degrees(((orig + mp.rotateDelta) % 360 + 360) % 360));
      }
    }

    /* ── 逐页烧录覆盖物（z 升序） ── */
    var env = {
      PDFLib: PDFLib, font: font, kfFont: kfFont, assets: assets,
      embedded: {},                            // assetId → PDFImage（同图只 embed 一次）
      rasterizeLine: opts.rasterizeLine || null,
      warnings: warnings, outDoc: outDoc
    };
    for (var pj = 0; pj < pages.length; pj++) {
      var mp2 = pages[pj];
      var page2 = outPageMap[mp2.id];
      var crop = page2.getCropBox();
      /* 导出 ctx：仅取 crop 偏移（内容流空间不含页旋转） */
      var ctx = G.makePageCtx({
        cropX: crop.x, cropY: crop.y,
        cropW: crop.width, cropH: crop.height, scale: 1, rotation: 0
      });
      var items = overlays.filter(function (o) { return o.pageId === mp2.id; })
        .sort(function (a, b) { return a.z - b.z; });
      for (var i = 0; i < items.length; i++) {
        try {
          await burnOverlay(page2, items[i], ctx, env);
        } catch (e) {
          warnings.push('覆盖物 ' + items[i].id + ' 导出失败：' + ((e && e.message) || e));
        }
      }
    }

    var out = await outDoc.save({ useObjectStreams: true });
    return { bytes: out, mime: 'application/pdf', warnings: warnings };
  }

  /* ── 单个覆盖物烧录（async：embed 链路必须同步 await） ── */

  async function burnOverlay(page, o, ctx, env) {
    var lib = env.PDFLib;
    var off = { dx: ctx.cropX, dy: ctx.cropY };

    if (o.type === 'text' && o.text) {
      var rgb = hexToRgb(o.text.color || '#111111') || { r: 0.07, g: 0.07, b: 0.07 };
      var color = lib.rgb(rgb.r, rgb.g, rgb.b);
      var fontSize = o.text.fontSize;
      var lines = (o.text.lines && o.text.lines.length)
        ? o.text.lines
        : (o.text.value ? [{ text: o.text.value, x: o.x, baseY: o.y + o.h - fontSize * 0.8 }] : []);
      for (var li = 0; li < lines.length; li++) {
        var ln = lines[li];
        if (!ln || !ln.text) continue;
        var miss = env.kfFont ? missingGlyphs(env.kfFont, ln.text) : [];
        var px = (ln.x != null ? ln.x : o.x) + off.dx;
        var py = ln.baseY + off.dy;
        if (env.font && miss.length === 0) {
          /* 正路：烘焙行真文本，可选中可检索 */
          page.drawText(ln.text, { x: px, y: py, size: fontSize, color: color, font: env.font });
        } else if (env.rasterizeLine) {
          /* 缺字行降级：栅格化 PNG（内容不丢，不可选中） */
          var ras = await env.rasterizeLine(ln.text, { fontSize: fontSize, color: o.text.color });
          if (ras && ras.bytes) {
            var png = await env.outDoc.embedPng(ras.bytes);
            var rp = G.toPdfLibPoint(ln.x != null ? ln.x : o.x, ln.baseY - ras.hPt * 0.2, ctx);
            page.drawImage(png, { x: rp.x, y: rp.y, width: ras.wPt, height: ras.hPt });
          } else {
            env.warnings.push('第 ' + (li + 1) + ' 行「' + miss.join('') + '」无栅格化兜底，已跳过');
          }
        } else {
          env.warnings.push('第 ' + (li + 1) + ' 行含缺字「' + miss.join('') + '」，已跳过导出');
        }
      }

    } else if (o.type === 'image' || o.type === 'signature') {
      var asset = env.assets[o.image && o.image.assetId];
      if (!asset || !asset.bytes) { env.warnings.push('图片缺失：' + o.id); return; }
      var img = env.embedded[o.image.assetId];
      if (!img) {
        var isPng = !asset.mime || /png/i.test(asset.mime);
        img = env.embedded[o.image.assetId] = await (isPng
          ? env.outDoc.embedPng(asset.bytes)
          : env.outDoc.embedJpg(asset.bytes));
      }
      var p = G.toPdfLibPoint(o.x, o.y, ctx);
      page.drawImage(img, { x: p.x, y: p.y, width: o.w, height: o.h });

    } else if (o.type === 'shape' && o.shape) {
      var r = G.toPdfLibRect({ x: o.x, y: o.y, w: o.w, h: o.h }, ctx);
      var fill = hexToRgb(o.shape.fill || '#ffffff');
      var stroke = o.shape.stroke ? hexToRgb(o.shape.stroke) : null;
      var opacity = o.shape.fillOpacity != null ? o.shape.fillOpacity : 1;
      if (o.shape.kind === 'ellipse') {
        page.drawEllipse({
          x: r.x + r.w / 2, y: r.y + r.h / 2,
          xScale: r.w / 2, yScale: r.h / 2,
          color: fill ? lib.rgb(fill.r, fill.g, fill.b) : undefined,
          opacity: opacity,
          borderColor: stroke ? lib.rgb(stroke.r, stroke.g, stroke.b) : undefined,
          borderWidth: o.shape.strokeWidth || 0
        });
      } else {
        /* rect / highlight / 白盒统一 drawRectangle */
        page.drawRectangle({
          x: r.x, y: r.y, width: r.w, height: r.h,
          color: fill ? lib.rgb(fill.r, fill.g, fill.b) : undefined,
          opacity: opacity,
          borderColor: stroke ? lib.rgb(stroke.r, stroke.g, stroke.b) : undefined,
          borderWidth: o.shape.strokeWidth || 0
        });
      }

    } else if (o.type === 'ink' && o.ink) {
      var rgb3 = hexToRgb(o.ink.stroke || '#111111') || { r: 0.07, g: 0.07, b: 0.07 };
      var strokeColor = lib.rgb(rgb3.r, rgb3.g, rgb3.b);
      var pts = o.ink.points;
      for (var k = 1; k < pts.length; k++) {
        var a = G.toPdfLibPoint(o.x + pts[k - 1][0], o.y + pts[k - 1][1], ctx);
        var b = G.toPdfLibPoint(o.x + pts[k][0], o.y + pts[k][1], ctx);
        page.drawLine({
          start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y },
          thickness: o.ink.strokeWidth || 2, color: strokeColor
        });
      }
    }
  }

  PDFED.export = { exportPdf: exportPdf, hexToRgb: hexToRgb, missingGlyphs: missingGlyphs };
})(typeof window !== 'undefined' ? window : globalThis);