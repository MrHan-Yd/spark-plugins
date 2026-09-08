/* PDF 格式转换层：→ Word（docx）/ → PPT（pptxgenjs）/ → Excel（SheetJS）
 *
 * 纯函数（linesToParagraphs / itemsToRows / detectTables）Node 可对拍；
 * 浏览器入口依赖 PdfEngine.openDoc / extractPageTextItems / extractPageRulingLines 与 canvas 渲染。
 * 依赖顺序：pdf.min.js → pdf-lib → engine.js → 本文件（xlsx / pptxgen.bundle / docx.umd 由 index.html 引入）。
 */
(function (global) {
  'use strict';

  var E = global.PdfEngine;

  function requireLib(name, obj) {
    if (!obj) throw new Error(name + ' 未加载');
    return obj;
  }

  /* ─────────── 纯函数：文本行 → 段落（Word 用） ─────────── */

  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[Math.floor(s.length / 2)];
  }

  /**
   * lines: [{text,x,baseline,top,fontSize,width,font}]（自页顶向下有序）
   * 返回 [{text, size(pt), heading:0|1|2, top, bottom, bold, italic}]；
   * 相邻小间距同字号行合并为一段。bold/italic 仅当段内所有行均为该样式时为真
   * （依据内嵌字体族名推断；标准 14 字体 pdf.js 报通用族名，识别不出）。
   */
  function linesToParagraphs(lines) {
    if (!lines || !lines.length) return [];
    var sizes = lines.map(function (l) { return l.fontSize; });
    var med = median(sizes.filter(function (s) { return s > 4; })) || 12;

    var paras = [];
    var cur = null;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var ratio = l.fontSize / med;
      var heading = ratio > 1.7 ? 1 : (ratio > 1.32 ? 2 : 0);
      var lbold = isBoldFamily(l.font), litalic = isItalicFamily(l.font);
      var gap = cur ? l.top - cur.bottom : Infinity;
      var mergeable = cur && !cur.heading && !heading &&
        gap < cur.size * 0.62 && Math.abs(l.fontSize - cur.size) < med * 0.3;
      if (mergeable) {
        // 换行接缝：前段以英文/数字/标点结尾且后段以英文开头时补一个空格，
        // CJK 文本保持 PDF 原始字符（通常无空格）。
        cur.text += (cur.text && !/[\s\u3000]$/.test(cur.text) &&
                     !/^[\s\u3000]/.test(l.text) &&
                     !/[\u4e00-\u9fff]/.test(l.text[0]) &&
                     /[\w,.:;!?%)\]'"]$/.test(cur.text) ? ' ' : '') + l.text;
        cur.bottom = l.baseline;
        cur.size = Math.max(cur.size, l.fontSize);
        cur.bold = cur.bold && lbold;
        cur.italic = cur.italic && litalic;
      } else {
        cur = { text: l.text, size: l.fontSize, heading: heading, top: l.top,
                bold: lbold, italic: litalic, bottom: l.baseline };
        paras.push(cur);
      }
    }
    return paras.map(function (p) {
      return { text: p.text, size: p.size, heading: p.heading, top: p.top,
               bottom: p.bottom, bold: !!p.bold, italic: !!p.italic };
    });
  }

  /* ─────────── 纯函数：文本项 → 行列表格（Excel 用） ─────────── */

  /**
   * items: 文本项（同 engine.extractPageTextItems 输出）
   * 返回 rows: [[cell, …], …]（含表头行的原始网格，不保证语义表头）。
   * 列聚类：按项的左缘 x 分簇，簇间距阈值 = 字号 × 0.9。
   */
  function itemsToRows(items) {
    if (!items || !items.length) return [];
    // 1) 列锚点：全部文本项按左缘聚类
    var sorted = items.slice().sort(function (a, b) { return a.x - b.x; });
    var cols = []; // {left, right}
    for (var i = 0; i < sorted.length; i++) {
      var it = sorted[i];
      var placed = false;
      for (var c = 0; c < cols.length; c++) {
        var col = cols[c];
        // 与现有列重叠，或间距小于阈值 → 归入该列
        if (it.x < col.right + Math.max(it.fontSize, 6) * 0.9 &&
            it.x + it.width > col.left) {
          col.left = Math.min(col.left, it.x);
          col.right = Math.max(col.right, it.x + it.width);
          placed = true;
          break;
        }
      }
      if (!placed) cols.push({ left: it.x, right: it.x + it.width });
    }
    cols.sort(function (a, b) { return a.left - b.left; });
    if (cols.length < 2) {
      // 单列：退化为每行一列
      var single = [];
      var lines0 = E.itemsToLines(items);
      for (var s = 0; s < lines0.length; s++) single.push([lines0[s].text]);
      return single;
    }

    // 2) 行聚类（与 itemsToLines 相同容差；行对象必须带 h，否则容差分支失效）
    var rows = [];
    var cur = null;
    var byBase = items.slice().sort(function (a, b) { return a.baseline - b.baseline; });
    for (var r = 0; r < byBase.length; r++) {
      var item = byBase[r];
      if (cur && Math.abs(item.baseline - cur.baseline) <= Math.max(cur.h, item.height) * 0.5) {
        cur.items.push(item);
        cur.h = Math.max(cur.h, item.height);
      } else {
        cur = { baseline: item.baseline, h: item.height, items: [item] };
        rows.push(cur);
      }
    }

    // 3) 每行按列归属填格
    var out = [];
    for (var k = 0; k < rows.length; k++) {
      var row = rows[k];
      var cells = new Array(cols.length).fill('');
      row.items.sort(function (a, b) { return a.x - b.x; });
      for (var m = 0; m < row.items.length; m++) {
        var t = row.items[m];
        var cx = t.x + t.width / 2;
        var best = -1, bestD = Infinity;
        for (var cc = 0; cc < cols.length; cc++) {
          var center = (cols[cc].left + cols[cc].right) / 2;
          var d = Math.abs(cx - center);
          if (d < bestD) { bestD = d; best = cc; }
        }
        if (best >= 0) cells[best] = (cells[best] ? cells[best] + ' ' : '') + t.str;
      }
      out.push(cells);
    }
    return out;
  }

  /* ─────────── 表格识别（框线网格 → 单元格，Word 用） ─────────── */

  function isBoldFamily(f) {
    return /bold|black|heavy|semib|demib|extrab|ultrab/i.test(f || '');
  }

  function isItalicFamily(f) {
    return /italic|oblique/i.test(f || '');
  }

  /** 线段按位置聚类（1pt 容差），组内保留原始段（跨表格同位线不并组）。 */
  function clusterLines(segs, key) {
    var sorted = segs.slice().sort(function (a, b) { return a[key] - b[key]; });
    var out = [];
    for (var i = 0; i < sorted.length; i++) {
      var s = sorted[i], g = out[out.length - 1];
      if (g && Math.abs(s[key] - g.pos) <= 1) {
        g.segs.push(s);
        // 增量平均：push 后 segs.length 已含新段
        g.pos = (g.pos * (g.segs.length - 1) + s[key]) / g.segs.length;
      } else {
        out.push({ pos: s[key], segs: [s] });
      }
    }
    return out;
  }

  /** 格内文本拼接：按 x 排序，间隙大于 0.28×字号补空格（与 engine.itemsToLines 同规则）。 */
  function joinCellItems(list) {
    list.sort(function (a, b) { return a.x - b.x; });
    var text = '', size = 0;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (text && !/\s$/.test(text) && !/^\s/.test(it.str) &&
          it.x - (list[i - 1].x + list[i - 1].width) > it.fontSize * 0.28) text += ' ';
      text += it.str;
      size += it.fontSize;
    }
    return { text: text, size: list.length ? size / list.length : 12 };
  }

  /**
   * 从框线网格重建表格。items: 文本项；rulings: engine.extractPageRulingLines 输出。
   * 返回 [{top,bottom,left,right,colWidths(pt),rows:[[{text,size,bold,italic}]]}]（自页顶坐标）。
   * 纯函数，Node 可对拍。仅识别横竖框线齐全的简单表格：贯穿整块区域的线条才参与网格，
   * 合并单元格的局部线被忽略（内容并入邻近格）；每页可有多个独立表格。
   */
  function detectTables(items, rulings) {
    if (!items || !items.length || !rulings || !rulings.h || !rulings.v ||
        rulings.h.length < 2 || rulings.v.length < 3) return [];
    var ys = clusterLines(rulings.h, 'y');
    var xs = clusterLines(rulings.v, 'x');
    if (ys.length < 2 || xs.length < 3) return [];
    var nb = ys.length - 1, nc = xs.length - 1;

    function vCover(xc, i) { // 竖线簇是否横跨行带 i
      for (var s = 0; s < xc.segs.length; s++)
        if (xc.segs[s].a <= ys[i].pos + 1 && xc.segs[s].b >= ys[i + 1].pos - 1) return true;
      return false;
    }
    function hCover(yc, j) { // 横线簇是否横跨列带 j
      for (var s = 0; s < yc.segs.length; s++)
        if (yc.segs[s].a <= xs[j].pos + 1 && yc.segs[s].b >= xs[j + 1].pos - 1) return true;
      return false;
    }

    // 1) 单元格存在性：四边各有线贯穿
    var cell = [];
    for (var i = 0; i < nb; i++) {
      var row = [];
      for (var j = 0; j < nc; j++)
        row.push(vCover(xs[j], i) && vCover(xs[j + 1], i) && hCover(ys[i], j) && hCover(ys[i + 1], j));
      cell.push(row);
    }

    // 2) 连通分量 → 每块收敛为“全线贯穿”的均匀网格（局部线=合并单元格，忽略）
    var seen = {}, tables = [];
    for (var bi = 0; bi < nb; bi++) {
      for (var cj = 0; cj < nc; cj++) {
        if (!cell[bi][cj] || seen[bi + '_' + cj]) continue;
        var bands = {}, cols = {}, queue = [[bi, cj]];
        seen[bi + '_' + cj] = 1;
        while (queue.length) {
          var q = queue.pop();
          bands[q[0]] = cols[q[1]] = 1;
          var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          for (var d = 0; d < 4; d++) {
            var i2 = q[0] + dirs[d][0], j2 = q[1] + dirs[d][1];
            if (i2 < 0 || i2 >= nb || j2 < 0 || j2 >= nc ||
                seen[i2 + '_' + j2] || !cell[i2][j2]) continue;
            seen[i2 + '_' + j2] = 1;
            queue.push([i2, j2]);
          }
        }
        var bKeys = Object.keys(bands).map(Number).sort(function (a, b) { return a - b; });
        var cKeys = Object.keys(cols).map(Number).sort(function (a, b) { return a - b; });
        var r0 = bKeys[0], r1 = bKeys[bKeys.length - 1];
        var c0 = cKeys[0], c1 = cKeys[cKeys.length - 1];

        function hSpanAll(yc) { // 横线簇贯穿 [c0..c1] 全部列带
          for (var k = c0; k <= c1; k++) {
            var ok = false;
            for (var s2 = 0; s2 < yc.segs.length; s2++)
              if (yc.segs[s2].a <= xs[k].pos + 1 && yc.segs[s2].b >= xs[k + 1].pos - 1) { ok = true; break; }
            if (!ok) return false;
          }
          return true;
        }
        function vSpanAll(xc) { // 竖线簇贯穿 [r0..r1] 全部行带
          for (var k = r0; k <= r1; k++) {
            var ok = false;
            for (var s3 = 0; s3 < xc.segs.length; s3++)
              if (xc.segs[s3].a <= ys[k].pos + 1 && xc.segs[s3].b >= ys[k + 1].pos - 1) { ok = true; break; }
            if (!ok) return false;
          }
          return true;
        }

        var ysF = [], xsF = [];
        for (var yk = r0; yk <= r1 + 1; yk++) if (hSpanAll(ys[yk])) ysF.push(ys[yk]);
        for (var xk = c0; xk <= c1 + 1; xk++) if (vSpanAll(xs[xk])) xsF.push(xs[xk]);
        // 外框必须完整，且行界连续（否则网格残缺，放弃该块）
        if (ysF.length !== r1 - r0 + 2 || ysF[0] !== ys[r0] || ysF[ysF.length - 1] !== ys[r1 + 1]) continue;
        if (xsF.length < 3 || xsF[0] !== xs[c0] || xsF[xsF.length - 1] !== xs[c1 + 1]) continue;

        // 3) 文本项按中心点归格（半开区间，避免边界重复归属）
        var tTop = ysF[0].pos, tBottom = ysF[ysF.length - 1].pos;
        var tLeft = xsF[0].pos, tRight = xsF[xsF.length - 1].pos;
        var grid = [];
        for (var ri = 0; ri < ysF.length - 1; ri++) {
          var grow = [];
          for (var gc = 0; gc < xsF.length - 1; gc++) grow.push([]);
          grid.push(grow);
        }
        var filled = 0;
        for (var n = 0; n < items.length; n++) {
          var it = items[n];
          var cx = it.x + it.width / 2, cy = it.baseline - it.height / 2;
          if (cx < tLeft || cx > tRight || cy < tTop || cy > tBottom) continue;
          var ci = 0;
          while (ci < xsF.length - 2 && xsF[ci + 1].pos <= cx) ci++;
          if (cx < xsF[ci].pos || cx >= xsF[ci + 1].pos) continue;
          var rw = 0;
          while (rw < ysF.length - 2 && ysF[rw + 1].pos <= cy) rw++;
          if (cy < ysF[rw].pos || cy >= ysF[rw + 1].pos) continue;
          grid[rw][ci].push(it);
          filled++;
        }
        if (grid.length < 1 || xsF.length - 1 < 2 || filled < 3) continue;

        var rows = [];
        var nonEmpty = 0;
        for (var rr = 0; rr < grid.length; rr++) {
          var cells = [];
          for (var cc = 0; cc < grid[rr].length; cc++) {
            var list = grid[rr][cc];
            var bold = list.length > 0, italic = list.length > 0;
            for (var b = 0; b < list.length; b++) {
              if (!isBoldFamily(list[b].font)) bold = false;
              if (!isItalicFamily(list[b].font)) italic = false;
            }
            var joined = joinCellItems(list);
            if (joined.text) nonEmpty++;
            cells.push({ text: joined.text, size: joined.size, bold: bold, italic: italic });
          }
          rows.push(cells);
        }
        if (nonEmpty < 3) continue;

        var widths = [];
        for (var w = 0; w < xsF.length - 1; w++) widths.push(xsF[w + 1].pos - xsF[w].pos);
        tables.push({ top: tTop, bottom: tBottom, left: tLeft, right: tRight,
                      colWidths: widths, rows: rows });
      }
    }
    return tables;
  }

  /** 行是否属于某表（中心点落入表 bbox，用于段落流中剔除表内行）。 */
  function lineInTable(l, tables) {
    var cx = l.x + l.width / 2;
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      if (l.baseline >= t.top - 2 && l.baseline <= t.bottom + 2 &&
          cx >= t.left - 2 && cx <= t.right + 2) return true;
    }
    return false;
  }

  /** 检测出的表格 → docx.Table（按列宽比例分配宽度，统一细框线）。 */
  function buildDocxTable(docx, t) {
    var total = 0;
    for (var i = 0; i < t.colWidths.length; i++) total += t.colWidths[i];
    var rows = [];
    for (var r = 0; r < t.rows.length; r++) {
      var cells = [];
      for (var c = 0; c < t.rows[r].length; c++) {
        var cell = t.rows[r][c];
        var runs = [];
        if (cell && cell.text) {
          var ropt = { text: cell.text, size: Math.round(Math.max(4, cell.size) * 2) };
          if (cell.bold) ropt.bold = true;
          if (cell.italic) ropt.italics = true;
          runs.push(new docx.TextRun(ropt));
        }
        cells.push(new docx.TableCell({
          width: { size: Math.max(4, Math.round(t.colWidths[c] / total * 100)), type: docx.WidthType.PERCENTAGE },
          children: [new docx.Paragraph({ children: runs })]
        }));
      }
      rows.push(new docx.TableRow({ children: cells }));
    }
    var B = { style: docx.BorderStyle.SINGLE, size: 4, color: '595959' };
    return new docx.Table({
      rows: rows,
      width: { size: 100, type: docx.WidthType.PERCENTAGE },
      borders: { top: B, bottom: B, left: B, right: B, insideHorizontal: B, insideVertical: B }
    });
  }

  /* ─────────── Word ─────────── */

  /**
   * opts: {}；hooks: { onPage(done,total) }
   * 返回 { blob }（docx）
   */
  async function pdfToDocx(data, opts, hooks) {
    var docx = requireLib('docx', global.docx);
    var pdf = await E.openDoc(data);
    try {
      var total = pdf.numPages;
      if (!total) throw new Error('该 PDF 没有可转换的页面');
      var children = [];
      var scannedPages = [];
      var failedPages = [];
      for (var p = 1; p <= total; p++) {
        if (hooks && hooks.onPage) hooks.onPage(p, total); // 页开始即上报，重页时进度条不空转
        try {
          var pageData = await E.extractPageTextItems(pdf, p);
          var allLines = E.itemsToLines(pageData.items, 0.5);
          if (!allLines.length) scannedPages.push(p);

          // 表格：从框线网格重建；失败/无框线时静默降级为纯文本
          var rulings = { h: [], v: [] };
          try { rulings = await E.extractPageRulingLines(pdf, p); } catch (e) { /* 降级 */ }
          var tables = detectTables(pageData.items, rulings);

          var freeLines = [];
          for (var fl = 0; fl < allLines.length; fl++)
            if (!lineInTable(allLines[fl], tables)) freeLines.push(allLines[fl]);
          var paras = linesToParagraphs(freeLines);
          var med = median(freeLines.map(function (l) { return l.fontSize; }).filter(function (s) { return s > 4; })) || 12;

          // 段落与表格按纵向位置交错输出
          var flow = [];
          for (var pi = 0; pi < paras.length; pi++) flow.push({ top: paras[pi].top, para: paras[pi] });
          for (var ti = 0; ti < tables.length; ti++) flow.push({ top: tables[ti].top, table: tables[ti] });
          flow.sort(function (a, b) { return a.top - b.top; });

          for (var fi = 0; fi < flow.length; fi++) {
            if (flow[fi].table) {
              children.push(buildDocxTable(docx, flow[fi].table));
              continue;
            }
            var para = flow[fi].para;
            if (para.heading === 1) {
              children.push(new docx.Paragraph({
                heading: docx.HeadingLevel.HEADING_1,
                children: [new docx.TextRun({ text: para.text, size: Math.round(Math.max(para.size, med * 1.7) * 2) })]
              }));
            } else if (para.heading === 2) {
              children.push(new docx.Paragraph({
                heading: docx.HeadingLevel.HEADING_2,
                children: [new docx.TextRun({ text: para.text, size: Math.round(Math.max(para.size, med * 1.35) * 2) })]
              }));
            } else {
              var ropt = { text: para.text, size: Math.round(Math.min(para.size, med * 1.15) * 2) };
              if (para.bold) ropt.bold = true;
              if (para.italic) ropt.italics = true;
              children.push(new docx.Paragraph({
                children: [new docx.TextRun(ropt)],
                spacing: { after: 120 }
              }));
            }
          }
        } catch (e) {
          failedPages.push(p); // 单页损坏只跳过该页，不拖垮整个文档
        }
        if (p < total) {
          children.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
        }
      }
      if (scannedPages.length === total) {
        throw new Error('这份 PDF 没有文字层（扫描件/图片型 PDF），无法提取文本。请先使用 OCR 工具识别后再转换。');
      }
      var doc = new docx.Document({
        sections: [{ properties: {}, children: children }]
      });
      var blob = await docx.Packer.toBlob(doc);
      return { blob: blob, scannedPages: scannedPages, failedPages: failedPages };
    } finally {
      try { pdf.destroy(); } catch (e) { /* 忽略 */ }
    }
  }

  /* ─────────── PPT ─────────── */

  /** 16:9 / 4:3 幻灯片尺寸（英寸） */
  var SLIDE_SIZES = { '16x9': [13.333, 7.5], '4x3': [10, 7.5] };

  /**
   * opts: { aspect:'16x9'|'4x3', scale }
   * hooks: { onPage(done,total) }
   * 返回 { blob }（pptx）
   */
  async function pdfToPptx(data, opts, hooks) {
    var PptxGenJS = requireLib('PptxGenJS', global.PptxGenJS);
    var pdf = await E.openDoc(data);
    try {
      var total = pdf.numPages;
      if (!total) throw new Error('该 PDF 没有可转换的页面');
      var slide = SLIDE_SIZES[opts.aspect || '16x9'] || SLIDE_SIZES['16x9'];
      var SW = slide[0], SH = slide[1];
      var pptx = new PptxGenJS();
      pptx.defineLayout({ name: 'PDFK', width: SW, height: SH });
      pptx.layout = 'PDFK';
      var q = opts.quality || 0.9;

      for (var p = 1; p <= total; p++) {
        if (hooks && hooks.onPage) hooks.onPage(p, total); // 页开始即上报：渲染一页较重，先动进度条
        // 每页按自身宽高比居中放置（横竖混排文档各页比例不同，不能用首页的框）
        var page = await pdf.getPage(p);
        var vp = page.getViewport({ scale: 1 });
        try { page.cleanup(); } catch (e) { /* 忽略 */ }
        var ar = vp.width / vp.height;
        var w, h;
        if (ar > SW / SH) { w = SW; h = SW / ar; } else { h = SH; w = SH * ar; }
        var canvas = await E.renderPage(pdf, p, opts.scale || 2);
        var dataUrl = canvas.toDataURL('image/jpeg', q);
        canvas.width = 0; canvas.height = 0;
        var s = pptx.addSlide();
        s.background = { color: 'FFFFFF' };
        s.addImage({ data: dataUrl, x: (SW - w) / 2, y: (SH - h) / 2, w: w, h: h });
      }
      var blob = await pptx.write({ outputType: 'blob' });
      return { blob: blob };
    } finally {
      try { pdf.destroy(); } catch (e) { /* 忽略 */ }
    }
  }

  /* ─────────── Excel ─────────── */

  /**
   * opts: { perSheet:boolean }（每页独立工作表）
   * hooks: { onPage(done,total) }
   * 返回 { blob }（xlsx）
   */
  async function pdfToXlsx(data, opts, hooks) {
    var XLSX = requireLib('XLSX', global.XLSX);
    var pdf = await E.openDoc(data);
    try {
      var total = pdf.numPages;
      if (!total) throw new Error('该 PDF 没有可转换的页面');
      var wb = XLSX.utils.book_new();
      var scannedPages = [];
      var failedPages = [];
      for (var p = 1; p <= total; p++) {
        if (hooks && hooks.onPage) hooks.onPage(p, total);
        var rows;
        try {
          var pageData = await E.extractPageTextItems(pdf, p);
          rows = itemsToRows(pageData.items);
        } catch (e) {
          failedPages.push(p); // 单页损坏只跳过该页
          rows = [];
        }
        if (!rows.length) scannedPages.push(p);
        var name = '第' + p + '页';
        if (opts.perSheet === false) {
          if (p === 1) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), '汇总');
          var ws0 = wb.Sheets['汇总'];
          XLSX.utils.sheet_add_aoa(ws0, rows, { origin: -1 });
          if (p < total) XLSX.utils.sheet_add_aoa(ws0, [['']], { origin: -1 });
        } else {
          var ws = XLSX.utils.aoa_to_sheet(rows.length ? rows : [['（本页无可提取文本）']]);
          XLSX.utils.book_append_sheet(wb, ws, name);
        }
      }
      if (scannedPages.length === total) {
        throw new Error('这份 PDF 没有文字层（扫描件/图片型），无法提取表格。请先使用 OCR 工具识别后再转换。');
      }
      var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      return { blob: new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), failedPages: failedPages };
    } finally {
      try { pdf.destroy(); } catch (e) { /* 忽略 */ }
    }
  }

  /* ─────────── 导出 ─────────── */

  var PdfConvert = {
    linesToParagraphs: linesToParagraphs,
    itemsToRows: itemsToRows,
    detectTables: detectTables,
    pdfToDocx: pdfToDocx,
    pdfToPptx: pdfToPptx,
    pdfToXlsx: pdfToXlsx
  };

  global.PdfConvert = PdfConvert;
  if (typeof module !== 'undefined' && module.exports) module.exports = PdfConvert;
})(typeof window !== 'undefined' ? window : globalThis);