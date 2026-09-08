/* PDF 工具箱 — 工具实现层
 *
 * 职责：各工具的文件处理流程（压缩/拆分/水印/提取/转图/转换三件套）与选项持久化、水印预览。
 * 依赖：app.js 的 window.App（文件会话/进度/保存/结果渲染）与 engine.js / convert.js。
 */
(function (global) {
  'use strict';

  var E = global.PdfEngine;
  var C = global.PdfConvert;

  /* ─────────── 小件 ─────────── */

  function savedPct(before, after) {
    if (!before) return '0%';
    var p = Math.round((before - after) / before * 100);
    return (p > 0 ? p : 0) + '%';
  }

  function levelLabel(level) {
    return level === 'light' ? '轻度' : level === 'strong' ? '强力' : '标准';
  }

  function segValue(id) {
    var el = document.querySelector('#' + id + ' .seg-btn.active');
    return el ? el.dataset.v : null;
  }

  /* ─────────── 压缩 ─────────── */

  async function compress() {
    var A = global.App;
    var s = A.session('compress');
    if (!s.files.length) { A.setStatus('请先添加 PDF 文件', 'err'); return; }
    s.files.forEach(function (f) { delete f.result; }); // 清掉上一轮产物，本轮失败不残留旧输出
    var level = segValue('comp-level') || 'standard';
    var stripMeta = A.$('#comp-meta').checked;
    var btn = A.$('#run-compress');
    btn.disabled = true;
    A.setFilesLocked('compress', true);
    A.progShow('compress', '准备压缩…');
    try {
      for (var i = 0; i < s.files.length; i++) {
        var f = s.files[i];
        A.setFileState('compress', i, 'busy', '压缩中');
        await A.yieldFrame();
        try {
          var r = await E.compressPdf(f.data, { level: level, stripMeta: stripMeta }, {
            onImage: function (done, total) {
              if (total) A.progUpdate('compress', '图片重压 ' + done + '/' + total, null);
            }
          });
          f.result = r;
          A.setFileState('compress', i, 'ok', '省 ' + savedPct(r.before, r.after));
        } catch (e) {
          A.setFileState('compress', i, 'err', '失败');
          A.setStatus(f.name + ' 压缩失败：' + e.message, 'err');
        }
      }
      var rows = [];
      for (var k = 0; k < s.files.length; k++) {
        var ff = s.files[k];
        if (!ff.result) continue;
        rows.push({
          name: A.stripPdfExt(ff.name) + '_已压缩.pdf',
          bytes: ff.result.bytes,
          meta: E.formatBytes(ff.result.before) + ' → ' + E.formatBytes(ff.result.after) +
                '（省 ' + savedPct(ff.result.before, ff.result.after) + '）'
        });
      }
      A.showRows('compress', rows,
        level !== 'light' ? '已按「' + levelLabel(level) + '」重压文档内图片；矢量文字不损失。若体积变化不大，说明文档以文字/矢量内容为主，本身已无可压空间。' : null);
      if (rows.length) {
        A.setStatus('压缩完成', 'ok');
        A.notify('PDF 压缩完成', rows.length + ' 个文件已就绪，请保存');
      } else {
        A.setStatus('没有成功压缩的文件', 'err');
      }
    } finally {
      A.progHide('compress');
      A.setFilesLocked('compress', false);
      btn.disabled = false;
    }
  }

  /* ─────────── 拆分 ─────────── */

  async function split() {
    var A = global.App;
    var s = A.session('split');
    if (!s.files.length) { A.setStatus('请先添加 PDF 文件', 'err'); return; }
    var mode = segValue('split-mode') || 'each';
    var every = Math.max(1, parseInt(A.$('#split-every').value, 10) || 1);
    var rangeStr = A.$('#split-range').value;
    if (mode === 'range' && !rangeStr.trim()) {
      A.setStatus('请填写页码范围，如 1-3, 5, 8-10', 'err');
      return;
    }
    var btn = A.$('#run-split');
    btn.disabled = true;
    A.setFilesLocked('split', true);
    A.progShow('split', '拆分中…');
    var rows = [];
    try {
      for (var i = 0; i < s.files.length; i++) {
        var f = s.files[i];
        A.setFileState('split', i, 'busy', '拆分中');
        await A.yieldFrame();
        try {
          var outs = await E.splitPdf(f.data, A.stripPdfExt(f.name),
            { type: mode, n: every, str: rangeStr },
            (function (fi) {
              return function (done, total) {
                A.progUpdate('split', f.name + '：' + done + '/' + total + ' 份',
                  (fi + done / total) / s.files.length * 100);
              };
            })(i));
          for (var j = 0; j < outs.length; j++) {
            rows.push({ name: outs[j].name, bytes: outs[j].bytes, meta: E.formatBytes(outs[j].bytes.byteLength) });
          }
          A.setFileState('split', i, 'ok', outs.length + ' 份');
        } catch (e) {
          A.setFileState('split', i, 'err', '失败');
          A.setStatus(f.name + ' 拆分失败：' + e.message, 'err');
        }
      }
      A.showRows('split', rows);
      if (rows.length) {
        A.setStatus('拆分完成，共 ' + rows.length + ' 个文档', 'ok');
        A.notify('PDF 拆分完成', '共生成 ' + rows.length + ' 个文档');
      }
    } finally {
      A.progHide('split');
      A.setFilesLocked('split', false);
      btn.disabled = false;
    }
  }

  /* ─────────── 水印 ─────────── */

  function readWmOptions() {
    var A = global.App;
    return {
      text: A.$('#wm-text').value || '',
      sizePt: parseInt(A.$('#wm-size').value, 10) || 48,
      opacity: (parseInt(A.$('#wm-opacity').value, 10) || 25) / 100,
      rotation: -(parseInt(A.$('#wm-rot').value, 10) || 0), // 滑杆顺时针为正 → 引擎逆时针为正
      color: A.$('#wm-color').value,
      position: wmPosValue(),
      tile: A.$('#wm-tile').checked
    };
  }

  function wmPosValue() {
    var a = document.querySelector('#wm-pos .pos.active');
    return a ? a.dataset.v : 'c';
  }

  /** 用系统字体把水印文字栅格化为透明 PNG（canvas），返回 { bytes, widthPt } */
  async function renderWmPng(opts) {
    var SCALE = 4;
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    var fontPx = opts.sizePt * SCALE;
    var font = fontPx + 'px "Microsoft YaHei", "Microsoft YaHei UI", "PingFang SC", sans-serif';
    ctx.font = font;
    var tw = ctx.measureText(opts.text).width;
    var pad = Math.ceil(fontPx * 0.2);
    canvas.width = Math.max(2, Math.ceil(tw) + pad * 2);
    canvas.height = Math.max(2, Math.ceil(fontPx * 1.5));
    ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = opts.color || '#808080';
    ctx.fillText(opts.text, pad, canvas.height / 2);
    var bytes = new Uint8Array(await new Promise(function (resolve) {
      canvas.toBlob(function (b) {
        if (!b) { resolve(new ArrayBuffer(0)); return; }
        b.arrayBuffer().then(resolve);
      }, 'image/png');
    }));
    return { bytes: bytes, widthPt: canvas.width / SCALE };
  }

  /** 水印预览：渲染第 1 个文件第 1 页，按当前参数叠加（与引擎同一套几何换算的可视坐标版） */
  async function renderWmPreview() {
    var A = global.App;
    var s = A.session('wm');
    var imgEl = A.$('#wm-preview-img');
    var empty = document.querySelector('#wm-preview .preview-empty');
    if (!s.files.length) {
      imgEl.hidden = true;
      empty.hidden = false;
      empty.querySelector('span').textContent = '添加文件后显示预览';
      A.$('#wm-refresh').hidden = true;
      return;
    }
    A.$('#wm-refresh').hidden = false;
    try {
      var opts = readWmOptions();
      var pdf = await E.openDoc(s.files[0].data);
      var page = await pdf.getPage(1);
      var vp1 = page.getViewport({ scale: 1 });
      var pw = vp1.width, ph = vp1.height;
      try { page.cleanup(); } catch (e) { /* 忽略 */ }
      var scale = 300 / pw;
      var canvas = await E.renderPage(pdf, 1, scale);
      try { pdf.destroy(); } catch (e) { /* 忽略 */ }

      var vw = canvas.width / scale, vh = canvas.height / scale;
      var png = await renderWmPng(opts);
      var bmp = await createImageBitmap(new Blob([png.bytes], { type: 'image/png' }));
      var wPt = png.widthPt, hPt = wPt * bmp.height / bmp.width;
      var visualRot = opts.rotation; // 引擎对页面 /Rotate 做了补偿，视觉角即用户所选角
      var ctx = canvas.getContext('2d');
      ctx.save();
      ctx.globalAlpha = opts.opacity;
      function stampAt(cx, cy) {
        var an = E.stampAnchor(cx, cy, wPt, hPt, visualRot);
        ctx.save();
        ctx.translate(an.x * scale, (vh - an.y) * scale);
        ctx.rotate(-visualRot * Math.PI / 180);
        ctx.drawImage(bmp, 0, -hPt * scale, wPt * scale, hPt * scale);
        ctx.restore();
      }
      if (opts.tile) {
        var stepX = wPt * 2.4, stepY = hPt * 4.2;
        for (var cy = hPt / 2; cy < vh + hPt; cy += stepY) {
          for (var cx = wPt / 2; cx < vw + wPt; cx += stepX) stampAt(cx, cy);
        }
      } else {
        var pt = E.positionPoint(opts.position, vw, vh, 0); // rot=0 → 原样返回可视坐标
        stampAt(pt.x, pt.y);
      }
      ctx.restore();
      bmp.close();
      imgEl.hidden = false;
      empty.hidden = true;
      imgEl.src = canvas.toDataURL('image/jpeg', 0.85);
    } catch (e) {
      imgEl.hidden = true;
      empty.hidden = false;
      empty.querySelector('span').textContent = '预览生成失败：' + e.message;
    }
  }

  var wmPreviewTimer = null;

  function scheduleWmPreview() {
    syncWmLabels();
    persistWm();
    if (wmPreviewTimer) clearTimeout(wmPreviewTimer);
    wmPreviewTimer = setTimeout(function () {
      // renderWmPreview 自带空文件处理（显示空态），删光文件后也要走到这里
      renderWmPreview().catch(function () {});
    }, 250);
  }

  function syncWmLabels() {
    var A = global.App;
    A.$('#wm-size-v').textContent = A.$('#wm-size').value;
    A.$('#wm-opacity-v').textContent = A.$('#wm-opacity').value + '%';
    A.$('#wm-rot-v').textContent = A.$('#wm-rot').value + '°';
  }

  function persistWm() {
    var o = readWmOptions();
    global.App.saveSetting('wm', {
      text: o.text, sizePt: o.sizePt, opacity: o.opacity, rotation: -o.rotation,
      color: o.color, position: o.position, tile: o.tile
    });
  }

  async function wm() {
    var A = global.App;
    var s = A.session('wm');
    if (!s.files.length) { A.setStatus('请先添加 PDF 文件', 'err'); return; }
    var opts = readWmOptions();
    if (!opts.text.trim()) { A.setStatus('请输入水印文字', 'err'); return; }
    var btn = A.$('#run-wm');
    btn.disabled = true;
    A.setFilesLocked('wm', true);
    A.progShow('wm', '生成水印…');
    var rows = [];
    try {
      var png = await renderWmPng(opts);
      for (var i = 0; i < s.files.length; i++) {
        var f = s.files[i];
        A.setFileState('wm', i, 'busy', '盖章中');
        await A.yieldFrame();
        try {
          var r = await E.watermarkPdf(f.data, png.bytes, {
            position: opts.position, opacity: opts.opacity, rotation: opts.rotation,
            tile: opts.tile, widthPt: png.widthPt
          }, { onPage: (function (fi) {
            return function (done, total) {
              A.progUpdate('wm', f.name + '：' + done + '/' + total + ' 页',
                (fi + done / total) / s.files.length * 100);
            };
          })(i) });
          A.setFileState('wm', i, 'ok', '完成');
          rows.push({ name: A.stripPdfExt(f.name) + '_水印.pdf', bytes: r.bytes, meta: E.formatBytes(r.bytes.byteLength) });
        } catch (e) {
          A.setFileState('wm', i, 'err', '失败');
          A.setStatus(f.name + ' 水印失败：' + e.message, 'err');
        }
      }
      A.showRows('wm', rows);
      if (rows.length) {
        A.setStatus('水印添加完成', 'ok');
        A.notify('水印添加完成', rows.length + ' 个文件待保存');
      }
    } catch (e) {
      A.setStatus('添加水印失败：' + e.message, 'err');
    } finally {
      A.progHide('wm');
      A.setFilesLocked('wm', false);
      btn.disabled = false;
    }
  }

  /* ─────────── 提取图片 ─────────── */

  async function extract() {
    var A = global.App;
    var s = A.session('extract');
    if (!s.files.length) { A.setStatus('请先添加 PDF 文件', 'err'); return; }
    var btn = A.$('#run-extract');
    btn.disabled = true;
    A.setFilesLocked('extract', true);
    A.progShow('extract', '解析内嵌图片…');
    var grid = [];
    var skippedTotal = 0;
    try {
      for (var i = 0; i < s.files.length; i++) {
        var f = s.files[i];
        A.setFileState('extract', i, 'busy', '提取中');
        await A.yieldFrame();
        try {
          var r = await E.extractImages(f.data, A.stripPdfExt(f.name), {
            onProgress: (function (fi) {
              return function (done, total) {
                A.progUpdate('extract', f.name + '：对象 ' + done + '/' + total,
                  (fi + done / Math.max(1, total)) / s.files.length * 100);
              };
            })(i)
          });
          skippedTotal += r.skipped;
          r.images.forEach(function (im) {
            var blob = new Blob([im.bytes], { type: im.ext === 'jpg' ? 'image/jpeg' : 'image/png' });
            grid.push({
              name: A.stripPdfExt(f.name) + '_' + im.name,
              blob: blob,
              url: URL.createObjectURL(blob),
              meta: im.width + '×' + im.height
            });
          });
          A.setFileState('extract', i, 'ok', r.images.length + ' 张');
        } catch (e) {
          A.setFileState('extract', i, 'err', '失败');
          A.setStatus(f.name + ' 提取失败：' + e.message, 'err');
        }
      }
      var note = skippedTotal ? '另有 ' + skippedTotal + ' 张图片使用了暂不支持的编码（JPX/CCITT/带预测器的 Flate 等）未提取。' : null;
      A.showGrid('extract', grid, note);
      if (grid.length) {
        A.setStatus('提取完成：共 ' + grid.length + ' 张图片', 'ok');
        A.notify('图片提取完成', '共 ' + grid.length + ' 张待保存');
      } else {
        A.setStatus('未找到可提取的图片' + (skippedTotal ? '（' + skippedTotal + ' 张为不支持的编码格式）' : ''), 'err');
      }
    } finally {
      A.progHide('extract');
      A.setFilesLocked('extract', false);
      btn.disabled = false;
    }
  }

  /* ─────────── 转图片 ─────────── */

  async function toimg() {
    var A = global.App;
    var s = A.session('toimg');
    if (!s.files.length) { A.setStatus('请先添加 PDF 文件', 'err'); return; }
    var fmt = segValue('toimg-fmt') || 'png';
    var scale = parseFloat(segValue('toimg-dpi')) || 2;
    var pages = A.$('#toimg-pages').value.trim() || null;
    var btn = A.$('#run-toimg');
    btn.disabled = true;
    A.setFilesLocked('toimg', true);
    A.progShow('toimg', '开始渲染…');
    var grid = [];
    try {
      for (var i = 0; i < s.files.length; i++) {
        var f = s.files[i];
        A.setFileState('toimg', i, 'busy', '转换中');
        await A.yieldFrame();
        try {
          var outs = await E.pdfToImages(f.data, A.stripPdfExt(f.name), {
            scale: scale, format: fmt, quality: 0.92, pages: pages
          }, { onPage: (function (fi) {
            return function (done, total) {
              A.progUpdate('toimg', f.name + '：第 ' + done + '/' + total + ' 页',
                (fi + done / total) / s.files.length * 100);
            };
          })(i) });
          outs.forEach(function (o) {
            grid.push({ name: o.name, blob: o.blob, url: URL.createObjectURL(o.blob) });
          });
          A.setFileState('toimg', i, 'ok', outs.length + ' 页');
        } catch (e) {
          A.setFileState('toimg', i, 'err', '失败');
          A.setStatus(f.name + ' 转换失败：' + e.message, 'err');
        }
      }
      A.showGrid('toimg', grid);
      if (grid.length) {
        A.setStatus('转换完成：共 ' + grid.length + ' 张图片', 'ok');
        A.notify('PDF 转图片完成', '共 ' + grid.length + ' 张待保存');
      }
    } finally {
      A.progHide('toimg');
      A.setFilesLocked('toimg', false);
      btn.disabled = false;
    }
  }

  /* ─────────── 转换三件套共用 ─────────── */

  async function convertOne(key, ext, fn) {
    var A = global.App;
    var s = A.session(key);
    if (!s.files.length) { A.setStatus('请先添加 PDF 文件', 'err'); return; }
    var btn = A.$('#run-' + key);
    btn.disabled = true;
    A.setFilesLocked(key, true);
    A.progShow(key, '转换中…');
    var rows = [];
    var failed = []; // 提取失败（被跳过）的页面
    try {
      for (var i = 0; i < s.files.length; i++) {
        var f = s.files[i];
        A.setFileState(key, i, 'busy', '转换中');
        await A.yieldFrame();
        try {
          var r = await fn(f, { onPage: (function (fi) {
            return function (done, total) {
              A.progUpdate(key, f.name + '：第 ' + done + '/' + total + ' 页',
                (fi + done / total) / s.files.length * 100);
            };
          })(i) });
          A.setFileState(key, i, 'ok', '完成');
          rows.push({ name: A.stripPdfExt(f.name) + '.' + ext, blob: r.blob, meta: E.formatBytes(r.blob.size) });
          if (r.failedPages && r.failedPages.length) failed.push(f.name + ' 第' + r.failedPages.join('、') + '页');
        } catch (e) {
          A.setFileState(key, i, 'err', '失败');
          A.setStatus(f.name + '：' + e.message, 'err');
        }
      }
      A.showRows(key, rows,
        failed.length ? '以下文件有页面提取失败（对应页为空），其余内容不受影响：' + failed.join('、') : null);
      if (rows.length) {
        A.setStatus('转换完成', 'ok');
        A.notify('转换完成', rows.length + ' 个文件待保存');
      }
    } finally {
      A.progHide(key);
      A.setFilesLocked(key, false);
      btn.disabled = false;
    }
  }

  async function toword() {
    return convertOne('toword', 'docx', function (f, hooks) {
      return C.pdfToDocx(f.data, {}, hooks);
    });
  }

  async function toppt() {
    var aspect = segValue('toppt-size') || '16x9';
    var scale = parseFloat(segValue('toppt-quality')) || 2;
    return convertOne('toppt', 'pptx', function (f, hooks) {
      return C.pdfToPptx(f.data, { aspect: aspect, scale: scale, quality: 0.9 }, hooks);
    });
  }

  async function toxls() {
    var perSheet = global.App.$('#toxls-persheet').checked;
    return convertOne('toxls', 'xlsx', function (f, hooks) {
      return C.pdfToXlsx(f.data, { perSheet: perSheet }, hooks);
    });
  }

  /* ─────────── 选项持久化（app.js 外壳回调） ─────────── */

  function persistCompress() {
    global.App.saveSetting('compress', {
      level: segValue('comp-level'),
      meta: global.App.$('#comp-meta').checked
    });
  }

  function persistSplit() {
    global.App.saveSetting('split', {
      mode: segValue('split-mode') || 'each',
      every: global.App.$('#split-every').value
    });
  }

  function persistToimg() {
    global.App.saveSetting('toimg', {
      fmt: segValue('toimg-fmt'),
      dpi: segValue('toimg-dpi'),
      pages: global.App.$('#toimg-pages').value
    });
  }

  function persistToppt() {
    global.App.saveSetting('toppt', {
      size: segValue('toppt-size'),
      q: segValue('toppt-quality')
    });
  }

  function onFilesAdded() {
    if (global.App.session('wm').files.length) scheduleWmPreview();
  }

  /** app.js 文件移除回调：水印页删光后清掉残留预览 */
  function onFilesRemoved(key) {
    if (key === 'wm') scheduleWmPreview();
  }

  /** app.js boot 调用：装配水印控件 + 恢复默认 */
  function initControls(A) {
    [['wm-text', 'input'], ['wm-size', 'input'], ['wm-opacity', 'input'], ['wm-rot', 'input'],
     ['wm-color', 'input'], ['wm-tile', 'change']].forEach(function (pair) {
      A.$('#' + pair[0]).addEventListener(pair[1], scheduleWmPreview);
    });
    A.$('#wm-size').addEventListener('input', syncWmLabels);
    A.$('#wm-opacity').addEventListener('input', syncWmLabels);
    A.$('#wm-rot').addEventListener('input', syncWmLabels);
    A.$('#wm-pos').addEventListener('click', function (e) {
      var btn = e.target.closest('.pos');
      if (!btn) return;
      A.$$('#wm-pos .pos').forEach(function (p) { p.classList.remove('active'); });
      btn.classList.add('active');
      scheduleWmPreview();
    });
    A.$('#wm-refresh').addEventListener('click', function () { renderWmPreview(); });
    syncWmLabels();
  }

  function applyWmSetting(wms) {
    var A = global.App;
    A.$('#wm-text').value = wms.text || '';
    A.$('#wm-size').value = wms.sizePt || 48;
    A.$('#wm-opacity').value = Math.round((wms.opacity == null ? 0.25 : wms.opacity) * 100);
    // persistWm 存的已是滑杆值（readWmOptions 取负、persistWm 再还原），直接回填即可
    A.$('#wm-rot').value = wms.rotation == null ? -30 : wms.rotation;
    if (wms.color) A.$('#wm-color').value = wms.color;
    A.$('#wm-tile').checked = !!wms.tile;
    if (wms.position) {
      A.$$('#wm-pos .pos').forEach(function (p) {
        p.classList.toggle('active', p.dataset.v === wms.position);
      });
    }
    syncWmLabels();
  }

  /* ─────────── 导出 ─────────── */

  global.Tools = {
    compress: compress,
    split: split,
    wm: wm,
    extract: extract,
    toimg: toimg,
    toword: toword,
    toppt: toppt,
    toxls: toxls,
    persistCompress: persistCompress,
    persistSplit: persistSplit,
    persistToimg: persistToimg,
    persistToppt: persistToppt,
    onFilesAdded: onFilesAdded,
    onFilesRemoved: onFilesRemoved,
    initControls: initControls,
    applyWmSetting: applyWmSetting
  };
})(typeof window !== 'undefined' ? window : globalThis);