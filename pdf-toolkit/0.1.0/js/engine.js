/* engine.js — PDF 引擎层：结构操作（pdf-lib）+ 渲染/文本（pdf.js）
 *
 * 约定：
 * - 本文件不依赖 DOM/vendor 全局做顶层初始化，可在 Node 中以注入的
 *   PDFLib/pdfjsLib 沙箱加载做冒烟对拍；浏览器侧由 app.js 调用。
 * - 输入一律为 Uint8Array；输出为 { bytes: Uint8Array } 或 Blob（渲染）。
 * - 所有函数 async，出错以 Error(message) 抛出（中文消息，可直接展示）。
 */
(function (global) {
  'use strict';

  var VENDOR = 'assets/vendor/';

  /* ─────────── 基础工具 ─────────── */

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /** 把 "1-3, 5, 8-" 解析为 [[1,3],[5,5],[8,pageCount]]；非法输入抛中文错误。 */
  function parseRanges(str, pageCount) {
    var groups = [];
    if (!str || !str.trim()) {
      for (var i = 1; i <= pageCount; i++) groups.push([i, i]);
      return groups;
    }
    var parts = str.split(/[,，;；]+/);
    for (var p = 0; p < parts.length; p++) {
      var seg = parts[p].trim();
      if (!seg) continue;
      var m = /^(\d+)?\s*(?:-|–|~)\s*(\d+)?$/.exec(seg);
      if (!m || (!m[1] && !m[2])) {
        m = /^(\d+)$/.exec(seg);
        if (!m) throw new Error('无法识别的页码范围：“' + seg + '”，示例：1-3, 5, 8-');
        var single = parseInt(m[1], 10);
        if (single < 1 || single > pageCount) {
          throw new Error('页码 ' + single + ' 超出范围（文档共 ' + pageCount + ' 页）');
        }
        groups.push([single, single]);
        continue;
      }
      var from = m[1] ? parseInt(m[1], 10) : 1;
      var to = m[2] ? parseInt(m[2], 10) : pageCount;
      if (from < 1) from = 1;
      if (to > pageCount) to = pageCount;
      if (from > to) throw new Error('页码范围无效：“' + seg + '”（起页大于止页）');
      groups.push([from, to]);
    }
    if (!groups.length) throw new Error('未解析到任何页码范围');
    return groups;
  }

  /** 旋转角度归一化为 0/90/180/270。 */
  function normRotation(deg) {
    var r = ((Math.round(deg) % 360) + 360) % 360;
    return [0, 90, 180, 270].indexOf(r) >= 0 ? r : (r < 45 ? 0 : r < 135 ? 90 : r < 225 ? 180 : 270);
  }

  /**
   * 计算盖章坐标：把一张 w×h 的图片以其中心落在目标点 (cx,cy) 上、
   * 旋转 rotateDeg（逆时针度数，pdf-lib degrees() 约定）后，drawImage 所需的锚点 x/y。
   * pdf-lib 旋转围绕锚点 (x,y)，未旋转图形占 [x,x+w]×[y,y+h]。
   * 纯函数，Node 可测。
   */
  function stampAnchor(cx, cy, w, h, rotateDeg) {
    var t = (rotateDeg || 0) * Math.PI / 180;
    var cos = Math.cos(t), sin = Math.sin(t);
    // 未旋转矩形中心相对锚点为 (w/2, h/2)，旋转 θ 后偏移：
    var dx = (w / 2) * cos - (h / 2) * sin;
    var dy = (w / 2) * sin + (h / 2) * cos;
    return { x: cx - dx, y: cy - dy };
  }

  /** 位置九宫格 → 目标点（页面宽高 pt，含边距比例）。纯函数，Node 可测。 */
  function positionPoint(pos, pw, ph, rotation) {
    // 旋转后的可视尺寸
    var vw = rotation % 180 === 0 ? pw : ph;
    var vh = rotation % 180 === 0 ? ph : pw;
    var mx = vw * 0.09, my = vh * 0.09;
    var px, py;
    switch (pos) {
      case 'tl': px = mx; py = vh - my; break;
      case 'tc': px = vw / 2; py = vh - my; break;
      case 'tr': px = vw - mx; py = vh - my; break;
      case 'ml': px = mx; py = vh / 2; break;
      case 'mr': px = vw - mx; py = vh / 2; break;
      case 'bl': px = mx; py = my; break;
      case 'bc': px = vw / 2; py = my; break;
      case 'br': px = vw - mx; py = my; break;
      default: px = vw / 2; py = vh / 2;
    }
    // 可视坐标(px 自左、py 自底) → 用户空间坐标（已按旋转几何推导验证）：
    // rot90: x=pw-py, y=px；rot180: x=pw-px, y=py；rot270: x=py, y=ph-px
    if (rotation === 90) { var x1 = pw - py; py = px; px = x1; }
    else if (rotation === 180) { px = pw - px; }
    else if (rotation === 270) { var y1 = ph - px; px = py; py = y1; }
    return { x: px, y: py };
  }

  /* ─────────── pdf.js 文档打开/渲染 ─────────── */

  function ensureWorker() {
    // workerSrc 只在浏览器环境设置；Node（冒烟对拍）走 pdf.js 自带的 fake worker
    if (typeof document === 'undefined') return;
    if (global.pdfjsLib && !global.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      global.pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.js';
    }
  }

  function openDoc(data) {
    ensureWorker();
    var lib = global.pdfjsLib;
    if (!lib) throw new Error('pdf.js 未加载');
    // pdf.js 会转移底层 buffer，先复制一份，保证调用方原数据仍可用
    var copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return lib.getDocument({
      data: copy,
      cMapUrl: VENDOR + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: VENDOR + 'standard_fonts/'
    }).promise;
  }

  function pdfLibLoad(data) {
    var lib = global.PDFLib;
    if (!lib) throw new Error('pdf-lib 未加载');
    return lib.PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
  }

  /**
   * 渲染一页到 canvas（返回 canvas 元素）。scale=1 对应 72dpi。
   */
  async function renderPage(pdf, pageNum, scale) {
    var page = await pdf.getPage(pageNum);
    try {
      var viewport = page.getViewport({ scale: scale });
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      var ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: viewport }).promise;
      return canvas;
    } finally {
      try { page.cleanup(); } catch (e) { /* 忽略清理失败 */ }
    }
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (b) resolve(b); else reject(new Error('图片编码失败'));
      }, mime, quality);
    });
  }

  /* ─────────── 合并 ─────────── */

  /**
   * 按可视化计划合并。
   * inputs: [{kind:'pdf', data:Uint8Array} | {kind:'image', data:Uint8Array, mime:'image/jpeg'|'image/png'}]
   * items:  [{kind:'pdf', input:idx, page:1基页码, rotation:0/90/180/270}
   *          | {kind:'image', input:idx, rotation:…}]
   * 返回 { bytes }。
   */
  async function mergeFromPlan(inputs, items, onProgress) {
    var lib = global.PDFLib;
    var out = await lib.PDFDocument.create();
    var srcCache = new Map();   // input idx -> pdf-lib 源文档
    var imgCache = new Map();   // input idx -> 已嵌入图片
    var baseCopies = new Map(); // input idx -> Map(page -> copied page)

    async function srcDoc(i) {
      if (!srcCache.has(i)) {
        srcCache.set(i, await lib.PDFDocument.load(inputs[i].data, { ignoreEncryption: true }));
      }
      return srcCache.get(i);
    }

    // 预拷贝：每个输入所需页各拷一次（同页多次出现且无旋转时复用）
    var need = new Map();
    for (var it = 0; it < items.length; it++) {
      var item = items[it];
      if (item.kind !== 'pdf') continue;
      if (!need.has(item.input)) need.set(item.input, new Map());
      var m = need.get(item.input);
      m.set(item.page, (m.get(item.page) || 0) + 1);
    }
    for (var entry of need) {
      var input = entry[0], pages = entry[1];
      var doc = await srcDoc(input);
      var indexes = [];
      var list = [];
      for (var pe of pages) { indexes.push(pe[0] - 1); list.push(pe[0]); }
      var copied = await out.copyPages(doc, indexes);
      var map = new Map();
      for (var ci = 0; ci < list.length; ci++) map.set(list[ci], copied[ci]);
      baseCopies.set(input, map);
    }

    var done = 0;
    for (var k = 0; k < items.length; k++) {
      var t = items[k];
      if (t.kind === 'pdf') {
        var page;
        var base = baseCopies.get(t.input);
        var srcRot = 0;
        if (base && base.has(t.page)) {
          page = base.get(t.page);
          srcRot = page.getRotation().angle || 0;
          base.delete(t.page); // 复用一次即移除；再次出现（旋转差异）时重拷
        } else {
          var src = await srcDoc(t.input);
          var cp = await out.copyPages(src, [t.page - 1]);
          page = cp[0];
          srcRot = page.getRotation().angle || 0;
        }
        out.addPage(page);
        var delta = ((t.rotation || 0) - srcRot) % 360;
        if (delta) {
          var target = ((srcRot + delta) % 360 + 360) % 360;
          page.setRotation(lib.degrees(normRotation(target)));
        }
      } else {
        var inp = inputs[t.input];
        var img;
        if (imgCache.has(t.input)) img = imgCache.get(t.input);
        else {
          img = inp.mime === 'image/png' ? await out.embedPng(inp.data) : await out.embedJpg(inp.data);
          imgCache.set(t.input, img);
        }
        var pg = out.addPage([img.width, img.height]);
        pg.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        if (t.rotation) pg.setRotation(lib.degrees(normRotation(t.rotation)));
      }
      done++;
      if (onProgress && done % 5 === 0) onProgress(done, items.length);
    }
    if (onProgress) onProgress(items.length, items.length);
    return { bytes: await out.save({ useObjectStreams: true }) };
  }

  /* ─────────── 拆分 ─────────── */

  /**
   * mode: {type:'each'} | {type:'every', n} | {type:'ranges', str}
   * 返回 [{name, bytes}]，name 形如 "原文_第1-3页.pdf"。
   */
  async function splitPdf(data, baseName, mode, onProgress) {
    var lib = global.PDFLib;
    var src = await lib.PDFDocument.load(data, { ignoreEncryption: true });
    var total = src.getPageCount();
    var groups;
    if (mode.type === 'each') {
      groups = [];
      for (var i = 1; i <= total; i++) groups.push([i, i]);
    } else if (mode.type === 'every') {
      var n = Math.max(1, Math.floor(mode.n || 1));
      groups = [];
      for (var s = 1; s <= total; s += n) groups.push([s, Math.min(total, s + n - 1)]);
    } else {
      groups = parseRanges(mode.str, total);
    }
    var results = [];
    for (var g = 0; g < groups.length; g++) {
      var from = groups[g][0], to = groups[g][1];
      var dst = await lib.PDFDocument.create();
      var idxs = [];
      for (var p2 = from; p2 <= to; p2++) idxs.push(p2 - 1);
      var pages = await dst.copyPages(src, idxs);
      for (var pp = 0; pp < pages.length; pp++) dst.addPage(pages[pp]);
      var bytes = await dst.save({ useObjectStreams: true });
      results.push({ name: baseName + '_第' + from + (to !== from ? '-' + to : '') + '页.pdf', bytes: bytes });
      if (onProgress) onProgress(g + 1, groups.length);
    }
    return results;
  }

  /* ─────────── 水印 ─────────── */

  /**
   * 文字水印盖章。png 为透明 PNG（app 用 canvas 按系统字体栅格化文字）。
   * opts: { position:'c'…, opacity:0-1, rotation:逆时针度, tile:boolean, widthPt }
   * hooks: { onPage(done,total) }
   * 页面自带 /Rotate 时做视觉补偿：内容旋转 = 期望视觉角度 + 页面旋转。
   */
  async function watermarkPdf(data, pngBytes, opts, hooks) {
    var lib = global.PDFLib;
    var doc = await lib.PDFDocument.load(data, { ignoreEncryption: true });
    var img = await doc.embedPng(pngBytes);
    var widthPt = Math.max(20, opts.widthPt || 140);
    var h = widthPt * img.height / img.width;
    var opacity = Math.max(0.02, Math.min(1, opts.opacity == null ? 0.25 : opts.opacity));
    var rotation = opts.rotation || 0;
    var pages = doc.getPages();

    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      var size = page.getSize();
      var rot = normRotation(page.getRotation().angle);
      var contentRot = ((rotation + rot) % 360 + 360) % 360;
      if (opts.tile) {
        var stepX = widthPt * 2.4, stepY = h * 4.2;
        for (var cy = h / 2; cy < size.height + h; cy += stepY) {
          for (var cx = widthPt / 2; cx < size.width + widthPt; cx += stepX) {
            var a = stampAnchor(cx, cy, widthPt, h, contentRot);
            page.drawImage(img, { x: a.x, y: a.y, width: widthPt, height: h,
              opacity: opacity, rotate: lib.degrees(contentRot) });
          }
        }
      } else {
        var pt = positionPoint(opts.position || 'c', size.width, size.height, rot);
        var an = stampAnchor(pt.x, pt.y, widthPt, h, contentRot);
        page.drawImage(img, { x: an.x, y: an.y, width: widthPt, height: h,
          opacity: opacity, rotate: lib.degrees(contentRot) });
      }
      if (hooks && hooks.onPage) hooks.onPage(i + 1, pages.length);
    }
    return { bytes: await doc.save({ useObjectStreams: true }) };
  }

  /* ─────────── 压缩 ─────────── */

  var COMPRESS_PRESETS = {
    light: { maxDim: 0, quality: 0, label: '轻度' },      // 0 = 不动图片
    standard: { maxDim: 1600, quality: 0.62, label: '标准' },
    strong: { maxDim: 1100, quality: 0.45, label: '强力' }
  };

  /** 从 PDFLib 文档枚举内嵌图片 XObject：返回 [{ref, stream, dict}] */
  function enumerateImages(doc) {
    var PDFName = global.PDFLib.PDFName;
    var out = [];
    var objs = doc.context.enumerateIndirectObjects();
    for (var i = 0; i < objs.length; i++) {
      var ref = objs[i][0], stream = objs[i][1];
      if (!stream || !stream.dict) continue;
      var subtype = stream.dict.get(PDFName.of('Subtype'));
      if (subtype && subtype.asString && subtype.asString() === '/Image') {
        out.push({ ref: ref, stream: stream, dict: stream.dict });
      }
    }
    return out;
  }

  function dictLookup(dict, key) {
    try {
      var v = dict.get(global.PDFLib.PDFName.of(key));
      return v;
    } catch (e) { return undefined; }
  }

  function num(v) {
    if (v == null) return null;
    if (typeof v.asNumber === 'function') { try { return v.asNumber(); } catch (e) { return null; } }
    if (typeof v === 'number') return v;
    return null;
  }

  function nameOf(v) {
    if (v == null) return null;
    if (typeof v.asString === 'function') { try { return v.asString(); } catch (e) { return null; } }
    return null;
  }

  /** Filter 可能是单个 Name 或数组，统一成字符串数组（如 ['/DCTDecode']）。 */
  function filterList(dict) {
    var f = dictLookup(dict, 'Filter');
    if (!f) return [];
    if (typeof f.size === 'function') {
      var arr = [];
      for (var i = 0; i < f.size(); i++) {
        var s = nameOf(f.get(i));
        if (s) arr.push(s);
      }
      return arr;
    }
    var one = nameOf(f);
    return one ? [one] : [];
  }

  /** FlateDecode 带 Predictor 的原始数据不是纯像素，无法直接转 PNG。 */
  function hasPredictor(dict) {
    var dp;
    try { dp = dict.get(global.PDFLib.PDFName.of('DecodeParms')); } catch (e) { return false; }
    if (!dp) return false;
    function check(p) {
      try {
        if (!p || typeof p.get !== 'function') return false;
        var pred = p.get(global.PDFLib.PDFName.of('Predictor'));
        var n = num(pred);
        return n != null && n > 1;
      } catch (e) { return false; }
    }
    if (typeof dp.size === 'function') {
      for (var i = 0; i < dp.size(); i++) if (check(dp.get(i))) return true;
      return false;
    }
    return check(dp);
  }

  /**
   * 压缩单个 PDF。
   * opts: { level:'light'|'standard'|'strong', stripMeta:boolean }
   * hooks: { onImage(done,total), onStage(text) } 可选
   * 返回 { bytes, before, after, removedImages }
   */
  async function compressPdf(data, opts, hooks) {
    opts = opts || {};
    var level = COMPRESS_PRESETS[opts.level || 'standard'] || COMPRESS_PRESETS.standard;
    var before = data.byteLength;
    var doc = await global.PDFLib.PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });

    if (opts.stripMeta !== false) {
      try {
        var info = doc.getInfoDict ? doc.getInfoDict() : null;
        if (info) {
          var keys = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer',
            'CreationDate', 'ModDate'];
          for (var ki = 0; ki < keys.length; ki++) {
            try { info.delete(global.PDFLib.PDFName.of(keys[ki])); } catch (e) { /* 无此键 */ }
          }
        }
      } catch (e) { /* Info 缺失不影响压缩 */ }
    }

    // 图片重压：只处理 DCTDecode（JPEG）——浏览器可原生解码/重编码，
    // Flate/JPX/CCITT 编码不在浏览器能力内，保持原样。
    if (level.maxDim > 0) {
      var images = enumerateImages(doc).filter(function (im) {
        var fl = filterList(im.dict);
        var isJpeg = fl.indexOf('/DCTDecode') >= 0 || fl.indexOf('/DCT') >= 0;
        if (!isJpeg) return false;
        // 带 SMask/遮罩的图片重压会牵连透明通道，保持原样更稳妥
        if (dictLookup(im.dict, 'SMask')) return false;
        var mask = num(dictLookup(im.dict, 'ImageMask'));
        if (mask === 1) return false;
        return true;
      });
      var handled = 0;
      var total = images.length;
      for (var ii = 0; ii < images.length; ii++) {
        var im = images[ii];
        if (hooks && hooks.onImage) hooks.onImage(ii, total);
        try {
          var w = num(dictLookup(im.dict, 'Width')) || 0;
          var h = num(dictLookup(im.dict, 'Height')) || 0;
          if (w < 40 || h < 40) continue; // 太小的不值得重压
          var jpeg = new Blob([im.stream.contents], { type: 'image/jpeg' });
          var bmp = await createImageBitmap(jpeg);
          var ratio = Math.min(1, level.maxDim / Math.max(bmp.width, bmp.height));
          var cw = Math.max(1, Math.round(bmp.width * ratio));
          var ch = Math.max(1, Math.round(bmp.height * ratio));
          var canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(bmp, 0, 0, cw, ch);
          bmp.close();
          var blob = await canvasToBlob(canvas, 'image/jpeg', level.quality);
          var newBytes = new Uint8Array(await blob.arrayBuffer());
          if (newBytes.byteLength >= im.stream.contents.byteLength) continue; // 没变小就保留原图
          var newDict = doc.context.obj({
            Type: 'XObject', Subtype: 'Image', Width: cw, Height: ch,
            ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode'
          });
          doc.context.assign(im.ref, global.PDFLib.PDFRawStream.of(newDict, newBytes));
          handled++;
        } catch (e) {
          // 单图失败不影响整体
        }
      }
      if (hooks && hooks.onImage) hooks.onImage(total, total);
    }

    var bytes = await doc.save({ useObjectStreams: true });
    return { bytes: bytes, before: before, after: bytes.byteLength, recompressed: handled };
  }

  /* ─────────── 提取图片 ─────────── */

  /** FlateDecode 流解压（zlib 封包；个别写出裸 deflate，raw 兜底重试）。 */
  function inflateFlate(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('环境不支持 Flate 解压'));
    }
    function via(fmt) {
      return new Promise(function (resolve, reject) {
        try {
          var reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(fmt)).getReader();
          var chunks = [], total = 0;
          (function pump() {
            reader.read().then(function (r) {
              if (r.done) {
                var out = new Uint8Array(total), off = 0;
                for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].byteLength; }
                resolve(out);
                return;
              }
              chunks.push(r.value); total += r.value.byteLength; pump();
            }).catch(reject);
          })();
        } catch (e) { reject(e); }
      });
    }
    return via('deflate').catch(function () { return via('deflate-raw'); });
  }

  /**
   * 提取所有内嵌图片。
   * browser 侧需要 canvas（Flate 原始像素 → PNG）。
   * 返回 { images:[{name, ext, bytes, width, height, source}], skipped }
   */
  async function extractImages(data, baseName, hooks) {
    var lib = global.PDFLib;
    var doc = await lib.PDFDocument.load(data, { ignoreEncryption: true });
    var found = enumerateImages(doc);
    var seen = new Map(); // 字节指纹 -> 序号，去重（同一 XObject 多页引用）
    var images = [], skipped = 0;

    for (var i = 0; i < found.length; i++) {
      var im = found[i];
      if (hooks && hooks.onProgress) hooks.onProgress(i, found.length);
      var w = num(dictLookup(im.dict, 'Width')) || 0;
      var h = num(dictLookup(im.dict, 'Height')) || 0;
      var fl = filterList(im.dict);
      var isJpeg = fl.indexOf('/DCTDecode') >= 0 || fl.indexOf('/DCT') >= 0;
      var isFlate = fl.indexOf('/FlateDecode') >= 0 || fl.indexOf('/Fl') >= 0;
      var bpc = num(dictLookup(im.dict, 'BitsPerComponent')) || 8;
      var cs = nameOf(dictLookup(im.dict, 'ColorSpace')) || '';
      var raw = im.stream.contents;
      var fp = raw.byteLength + '_' + raw[0] + '_' + raw[1] + '_' + raw[Math.min(raw.length - 1, 99)];
      if (seen.has(fp)) continue;
      seen.set(fp, 1);

      try {
        if (isJpeg) {
          images.push({ name: 'img_' + (images.length + 1) + '_' + w + 'x' + h + '.jpg', ext: 'jpg', bytes: new Uint8Array(raw), width: w, height: h });
        } else if (isFlate && bpc === 8 && !hasPredictor(im.dict) &&
                   (cs.indexOf('/DeviceRGB') === 0 || cs.indexOf('/RGB') === 0)) {
          // stream.contents 是 Flate 压缩后的字节，先解压成原始像素再转 PNG
          var pixels = await inflateFlate(raw);
          var png = await rawRgbToPng(pixels, w, h);
          if (png) images.push({ name: 'img_' + (images.length + 1) + '_' + w + 'x' + h + '.png', ext: 'png', bytes: png, width: w, height: h });
          else skipped++;
        } else if (isFlate && bpc === 8 && !hasPredictor(im.dict) &&
                   cs.indexOf('/DeviceGray') === 0) {
          var pixels2 = await inflateFlate(raw);
          var png2 = await rawGrayToPng(pixels2, w, h);
          if (png2) images.push({ name: 'img_' + (images.length + 1) + '_' + w + 'x' + h + '.png', ext: 'png', bytes: png2, width: w, height: h });
          else skipped++;
        } else {
          skipped++; // JPX/CCITT/Indexed/带预测器等暂不支持
        }
      } catch (e) {
        skipped++;
      }
    }
    if (hooks && hooks.onProgress) hooks.onProgress(found.length, found.length);
    return { images: images, skipped: skipped };
  }

  /** 原始 RGB 字节 → PNG（经 canvas）。 */
  async function rawRgbToPng(raw, w, h) {
    if (!w || !h || raw.byteLength < w * h * 3) return null;
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    var imgData = ctx.createImageData(w, h);
    var px = imgData.data, n = w * h;
    for (var i = 0; i < n; i++) {
      px[i * 4] = raw[i * 3];
      px[i * 4 + 1] = raw[i * 3 + 1];
      px[i * 4 + 2] = raw[i * 3 + 2];
      px[i * 4 + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    var blob = await canvasToBlob(canvas, 'image/png');
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** 原始灰度字节 → PNG。 */
  async function rawGrayToPng(raw, w, h) {
    if (!w || !h || raw.byteLength < w * h) return null;
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    var imgData = ctx.createImageData(w, h);
    var px = imgData.data, n = w * h;
    for (var i = 0; i < n; i++) {
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = raw[i];
      px[i * 4 + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    var blob = await canvasToBlob(canvas, 'image/png');
    return new Uint8Array(await blob.arrayBuffer());
  }

  /* ─────────── 转图片 ─────────── */

  /**
   * opts: { scale, format:'png'|'jpeg', quality, pages:{from,to}|null }
   * hooks: { onPage(done,total) }
   * 返回 [{name, blob}]。
   */
  async function pdfToImages(data, baseName, opts, hooks) {
    var pdf = await openDoc(data);
    try {
      var total = pdf.numPages;
      var from = 1, to = total;
      if (opts.pages) {
        var groups = parseRanges(opts.pages, total);
        var flat = [];
        for (var g = 0; g < groups.length; g++) {
          for (var p = groups[g][0]; p <= groups[g][1]; p++) flat.push(p);
        }
        if (!flat.length) throw new Error('未选中任何页面');
        return await renderList(flat);
      }
      var all = [];
      for (var q = 1; q <= total; q++) all.push(q);
      return await renderList(all);

      async function renderList(pageNums) {
        var out = [];
        var mime = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';
        for (var i = 0; i < pageNums.length; i++) {
          var n = pageNums[i];
          var canvas = await renderPage(pdf, n, opts.scale || 2);
          var blob = await canvasToBlob(canvas, mime, opts.quality || 0.92);
          canvas.width = 0; canvas.height = 0;
          var ext = opts.format === 'jpeg' ? 'jpg' : 'png';
          out.push({ name: baseName + '_第' + n + '页.' + ext, blob: blob });
          if (hooks && hooks.onPage) hooks.onPage(i + 1, pageNums.length);
        }
        return out;
      }
    } finally {
      try { pdf.destroy(); } catch (e) { /* 忽略 */ }
    }
  }

  /* ─────────── 文本提取（供转换层用） ─────────── */

  /**
   * 提取指定页的文本项（含坐标），返回
   * [{str, x, y(自页顶), width, height, fontSize}]
   */
  async function extractPageTextItems(pdf, pageNum) {
    var page = await pdf.getPage(pageNum);
    try {
      var vp = page.getViewport({ scale: 1 });
      var content = await page.getTextContent();
      var styles = content.styles || {};
      var items = [];
      for (var i = 0; i < content.items.length; i++) {
        var it = content.items[i];
        if (!it.str) continue;
        // C0 控制字符（除 \t\n\r）与 DEL 在 XML 1.0 非法，坏 ToUnicode 的 PDF 会产生，须滤掉防 docx/xlsx 损坏
        var str0 = String(it.str).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
        if (!str0.trim()) continue;
        var m = it.transform; // pdf.js transform: [a,b,c,d,e,f]，e,f 为设备空间坐标
        var height = Math.sqrt(m[2] * m[2] + m[3] * m[3]) || it.height || 12;
        var fontSize = Math.sqrt(m[0] * m[0] + m[1] * m[1]) || height;
        var st = styles[it.fontName] || {};
        items.push({
          str: str0,
          x: m[4],
          y: vp.height - m[5] - height, // 转为自页顶的基线上缘
          baseline: vp.height - m[5],
          width: it.width,
          height: height,
          fontSize: fontSize,
          font: st.fontFamily || '' // 字体族（内嵌字体为真实名，标准字体为 sans-serif 等通用族）
        });
      }
      return { items: items, pageWidth: vp.width, pageHeight: vp.height };
    } finally {
      try { page.cleanup(); } catch (e) { /* 忽略 */ }
    }
  }

  /**
   * 把一页的文本项按 y 聚类成行、行内按 x 排序拼接。
   * 纯函数，Node 可测。
   * yTol 行高容差比例（默认 0.5）
   */
  function itemsToLines(items, yTol) {
    if (!items.length) return [];
    yTol = yTol == null ? 0.5 : yTol;
    var sorted = items.slice().sort(function (a, b) { return a.baseline - b.baseline || a.x - b.x; });
    var lines = [], cur = null;
    for (var i = 0; i < sorted.length; i++) {
      var it = sorted[i];
      var refH = cur ? cur.h : it.height;
      if (cur && Math.abs(it.baseline - cur.baseline) <= Math.max(refH, it.height) * yTol) {
        cur.items.push(it);
        // 增量平均：push 后 items.length 已含新项，旧均值 × (N-1) + 新值再除 N
        cur.baseline = (cur.baseline * (cur.items.length - 1) + it.baseline) / cur.items.length;
        cur.h = Math.max(cur.h, it.height);
      } else {
        cur = { baseline: it.baseline, h: it.height, items: [it] };
        lines.push(cur);
      }
    }
    var out = [];
    for (var l = 0; l < lines.length; l++) {
      var row = lines[l];
      row.items.sort(function (a, b) { return a.x - b.x; });
      var text = '';
      for (var t = 0; t < row.items.length; t++) {
        var piece = row.items[t];
        if (text && !/\s$/.test(text) && !/^\s/.test(piece.str)) {
          var prev = row.items[t - 1];
          var gap = piece.x - (prev.x + prev.width);
          if (gap > prev.fontSize * 0.28) text += ' ';
        }
        text += piece.str;
      }
      var first = row.items[0];
      // 行字体：按总宽度取众数族（供转换层判加粗/斜体）
      var fams = {};
      for (var f = 0; f < row.items.length; f++) {
        var fam = row.items[f].font || '';
        fams[fam] = (fams[fam] || 0) + row.items[f].width;
      }
      var bestFam = '', bestW = -1;
      for (var fk in fams) if (fams[fk] > bestW) { bestW = fams[fk]; bestFam = fk; }
      out.push({
        text: text,
        x: first.x,
        baseline: row.baseline,
        top: row.baseline - row.h,
        fontSize: row.h,
        font: bestFam,
        width: row.items.length === 1 ? first.width :
          (row.items[row.items.length - 1].x + row.items[row.items.length - 1].width - first.x)
      });
    }
    return out;
  }

  /* ─────────── 版面框线提取（供转换层表格识别） ─────────── */

  /** 仿射矩阵复合：先应用 m1 再应用 m2（列向量约定，与 PDF `cm` 语义一致）。纯函数。 */
  function mulMatrix(m2, m1) {
    return [
      m2[0] * m1[0] + m2[2] * m1[1],
      m2[1] * m1[0] + m2[3] * m1[1],
      m2[0] * m1[2] + m2[2] * m1[3],
      m2[1] * m1[2] + m2[3] * m1[3],
      m2[0] * m1[4] + m2[2] * m1[5] + m2[4],
      m2[1] * m1[4] + m2[3] * m1[5] + m2[5]
    ];
  }

  /** 同轴共线段合并：按位置聚类(1pt)→同组内间隙≤2pt 接续（虚线边框并成整线）→丢弃 <5pt 碎片。 */
  function mergeCollinear(segs, posKey) {
    var sorted = segs.slice().sort(function (p, q) { return p[posKey] - q[posKey] || p.a - q.a; });
    var groups = [];
    for (var i = 0; i < sorted.length; i++) {
      var s = sorted[i];
      var g = groups.length ? groups[groups.length - 1] : null;
      if (g && Math.abs(s[posKey] - g.pos) <= 1.0) {
        g.segs.push(s);
        // 增量平均：push 后 segs.length 已含新段
        g.pos = (g.pos * (g.segs.length - 1) + s[posKey]) / g.segs.length;
      } else {
        groups.push({ pos: s[posKey], segs: [s] });
      }
    }
    var out = [];
    for (var k = 0; k < groups.length; k++) {
      var list = groups[k].segs.slice().sort(function (p, q) { return p.a - q.a; });
      var merged = [{ a: list[0].a, b: list[0].b }];
      for (var m = 1; m < list.length; m++) {
        var cur = merged[merged.length - 1], t = list[m];
        if (t.a - cur.b <= 2) cur.b = Math.max(cur.b, t.b);
        else merged.push({ a: t.a, b: t.b });
      }
      for (var n = 0; n < merged.length; n++) {
        if (merged[n].b - merged[n].a >= 5) {
          var o = { a: merged[n].a, b: merged[n].b };
          o[posKey] = groups[k].pos;
          out.push(o);
        }
      }
    }
    return out;
  }

  /**
   * 提取一页的轴对齐框线段（表格线候选）。
   * 坐标与 extractPageTextItems 同体系：x=用户空间，y=自页顶向下（scale=1，
   * 旋转页两者采用同一映射，相对几何关系保持一致，网格识别不受影响）。
   * 覆盖描边路径与细填充矩形（Word 导出的表格边框常为细填充条）。
   * 返回 { h:[{y,a,b}], v:[{x,a,b}] }（a/b 为线段两端坐标）；任何异常返回空集，
   * 转换层据此降级为纯文本转换。
   */
  async function extractPageRulingLines(pdf, pageNum) {
    var out = { h: [], v: [] };
    var page = null;
    try {
      page = await pdf.getPage(pageNum);
      var vp = page.getViewport({ scale: 1 });
      var OPS = global.pdfjsLib.OPS;
      var ol = await page.getOperatorList();
      var H = vp.height;
      var raw = [];
      var ctm = [1, 0, 0, 1, 0, 0]; // 路径坐标是构造时的原始坐标，CTM 需自行跟踪
      var stack = [];
      var stackDropped = false; // save 栈超限被丢弃 → 后续 restore 会弹错位矩阵，坐标不可信

      function pt(x, y) {
        return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
      }
      function addSeg(a, b) {
        if (raw.length >= 6000) return;
        if (!isFinite(a[0]) || !isFinite(a[1]) || !isFinite(b[0]) || !isFinite(b[1])) return;
        if (Math.abs(a[0]) > 1e5 || Math.abs(a[1]) > 1e5 ||
            Math.abs(b[0]) > 1e5 || Math.abs(b[1]) > 1e5) return;
        raw.push([a[0], a[1], b[0], b[1]]);
      }

      var PAINTED = {};
      PAINTED[OPS.stroke] = PAINTED[OPS.closeStroke] = PAINTED[OPS.fill] = PAINTED[OPS.eoFill] =
        PAINTED[OPS.fillStroke] = PAINTED[OPS.eoFillStroke] = PAINTED[OPS.closeFillStroke] =
        PAINTED[OPS.closeEOFillStroke] = 1;

      var pending = null; // 最近一条未上色的路径
      var LIMIT = Math.min(ol.fnArray.length, 120000);
      for (var i = 0; i < LIMIT; i++) {
        var fn = ol.fnArray[i], args = ol.argsArray[i];
        if (fn === OPS.save) {
          if (stack.length < 64) stack.push(ctm); else stackDropped = true;
        } else if (fn === OPS.restore) {
          if (stack.length) ctm = stack.pop();
        } else if (fn === OPS.transform) {
          // pdf.js 把 cm 的 6 个参数平铺在 args 上（args = [a,b,c,d,e,f]）
          if (args.length === 6 && typeof args[0] === 'number') ctm = mulMatrix(args, ctm);
        } else if (fn === OPS.paintFormXObjectBegin) {
          if (stack.length < 64) stack.push(ctm); else stackDropped = true;
          if (args[0] && args[0].length === 6) ctm = mulMatrix(args[0], ctm);
        } else if (fn === OPS.paintFormXObjectEnd) {
          if (stack.length) ctm = stack.pop();
        } else if (fn === OPS.constructPath) {
          var ops = args[0], coords = args[1], c = 0;
          var cur = null, drawn = [];
          for (var k = 0; k < ops.length; k++) {
            var op = ops[k];
            if (op === OPS.moveTo) {
              var p0 = pt(coords[c], coords[c + 1]); c += 2;
              cur = { s: p0, c: p0 };
            } else if (op === OPS.lineTo) {
              var p1 = pt(coords[c], coords[c + 1]); c += 2;
              if (cur) { drawn.push([cur.c, p1]); cur.c = p1; }
            } else if (op === OPS.curveTo) {
              c += 6; if (cur) cur.c = pt(coords[c - 2], coords[c - 1]);
            } else if (op === OPS.curveTo2) {
              c += 4; if (cur) cur.c = pt(coords[c - 2], coords[c - 1]);
            } else if (op === OPS.curveTo3) {
              // PDF `y` 算子只有 4 个操作数（x1 y1 x3 y3），与 `v` 相同
              c += 4; if (cur) cur.c = pt(coords[c - 2], coords[c - 1]);
            } else if (op === OPS.closePath) {
              if (cur) { drawn.push([cur.c, cur.s]); cur.c = cur.s; }
            } else if (OPS.rectangle != null && op === OPS.rectangle) {
              var rx = coords[c], ry = coords[c + 1], rw = coords[c + 2], rh = coords[c + 3]; c += 4;
              var a = pt(rx, ry), b = pt(rx + rw, ry + rh);
              var x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
              var y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
              drawn.push([[x0, y0], [x1, y0]], [[x0, y1], [x1, y1]],
                         [[x0, y0], [x0, y1]], [[x1, y0], [x1, y1]]);
              cur = { s: [x0, y0], c: [x0, y0] };
            } else {
              cur = null; break; // 未知路径算子：放弃本路径
            }
          }
          pending = drawn; // 上色与否由后续 paint 类算子决定
        } else if (PAINTED[fn] && pending) {
          for (var d = 0; d < pending.length; d++) addSeg(pending[d][0], pending[d][1]);
          pending = null;
        }
      }

      // save/restore 栈曾超限丢弃 → 矩阵配对已破坏，继续输出只会是错位伪线
      if (stackDropped) return out;

      // 归一化：仅保留轴对齐、去短、y 转自页顶
      var tol = 0.6, minLen = 5;
      var hs = [], vs = [];
      for (var r = 0; r < raw.length; r++) {
        var s = raw[r];
        var dx = Math.abs(s[2] - s[0]), dy = Math.abs(s[3] - s[1]);
        if (dy <= tol && dx >= minLen) {
          hs.push({ y: H - (s[1] + s[3]) / 2, a: Math.min(s[0], s[2]), b: Math.max(s[0], s[2]) });
        } else if (dx <= tol && dy >= minLen) {
          var yLo = Math.min(s[1], s[3]), yHi = Math.max(s[1], s[3]);
          vs.push({ x: (s[0] + s[2]) / 2, a: H - yHi, b: H - yLo });
        }
      }
      out.h = mergeCollinear(hs, 'y');
      out.v = mergeCollinear(vs, 'x');
      return out;
    } catch (e) {
      return { h: [], v: [] }; // 框线提取失败不影响转换，降级为纯文本
    } finally {
      if (page) { try { page.cleanup(); } catch (e2) { /* 忽略 */ } }
    }
  }

  /* ─────────── 导出 ─────────── */

  var PdfEngine = {
    formatBytes: formatBytes,
    parseRanges: parseRanges,
    normRotation: normRotation,
    stampAnchor: stampAnchor,
    positionPoint: positionPoint,
    openDoc: openDoc,
    pdfLibLoad: pdfLibLoad,
    renderPage: renderPage,
    canvasToBlob: canvasToBlob,
    mergeFromPlan: mergeFromPlan,
    splitPdf: splitPdf,
    watermarkPdf: watermarkPdf,
    compressPdf: compressPdf,
    extractImages: extractImages,
    pdfToImages: pdfToImages,
    extractPageTextItems: extractPageTextItems,
    extractPageRulingLines: extractPageRulingLines,
    mulMatrix: mulMatrix,
    itemsToLines: itemsToLines,
    COMPRESS_PRESETS: COMPRESS_PRESETS
  };

  global.PdfEngine = PdfEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = PdfEngine;
})(typeof window !== 'undefined' ? window : globalThis);