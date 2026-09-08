/* PDF 工具箱 — 合并工具：可视化页面编辑器
 *
 * 职责：多文件（PDF + JPG/PNG 图片）添加、逐页缩略图画板、
 *       拖拽排序 / 旋转 / 复制 / 删除、合并执行（走 engine.mergeFromPlan）。
 * 依赖：app.js 的 window.App（拖放/进度/结果渲染），engine.js，PDFLib。
 * 结构：files[]（源文件 {id,name,kind,data,mime,pageCount,thumbs}）
 *       + items[]（扁平页面项 {uid,fileId,page,rotation}）。
 */
(function (global) {
  'use strict';

  var A = null; // window.App
  var E = null; // PdfEngine（init 时从 app.engine 取，缩略图队列等模块级函数也要用）

  var state = {
    files: [],
    items: []
  };
  var uidSeq = 1;

  function nextId() { return ++uidSeq; }

  function fileOf(fileId) {
    for (var i = 0; i < state.files.length; i++) {
      if (state.files[i].id === fileId) return state.files[i];
    }
    return null;
  }

  function itemIndex(uid) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].uid === uid) return i;
    }
    return -1;
  }

  /** 图片文件的缩略图是 ObjectURL，文件不再使用时要回收。 */
  function revokeImageThumbs(file) {
    if (file && file.kind === 'image' && file.thumbs && file.thumbs[1]) {
      try { URL.revokeObjectURL(file.thumbs[1]); } catch (e) { /* 忽略 */ }
      file.thumbs[1] = null;
    }
  }

  function pruneFiles() {
    var used = {};
    state.items.forEach(function (it) { used[it.fileId] = 1; });
    state.files = state.files.filter(function (f) {
      if (!used[f.id]) { revokeImageThumbs(f); return false; }
      return true;
    });
  }

  /* ─────────── 初始化 ─────────── */

  function init(app) {
    A = app;
    E = app.engine;

    var zone = A.$('#dz-merge');
    var input = A.$('#file-merge');
    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('drag'); });
    });
    zone.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) addFiles(Array.prototype.slice.call(files));
    });
    input.addEventListener('change', function () {
      if (input.files && input.files.length) addFiles(Array.prototype.slice.call(input.files));
      input.value = '';
    });

    A.$('#merge-rot-all').addEventListener('click', function () {
      state.items.forEach(function (it) { it.rotation = (it.rotation + 90) % 360; });
      renderBoard();
    });
    A.$('#merge-clear').addEventListener('click', function () {
      state.files.forEach(revokeImageThumbs);
      state.files = [];
      state.items = [];
      renderBoard();
    });
    A.$('#run-merge').addEventListener('click', function () {
      run().catch(function (e) {
        A.setStatus('合并失败：' + (e && e.message ? e.message : e), 'err');
      });
    });

    wireBoardDnd();
    renderBoard();
  }

  /* ─────────── 添加文件 ─────────── */

  async function addFiles(list) {
    var skipped = [];
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var lower = (f.name || '').toLowerCase();
      try {
        if (/\.pdf$/.test(lower)) {
          var data = new Uint8Array(await f.arrayBuffer());
          var count = await pageCount(data);
          var file = {
            id: 'f' + nextId(), name: f.name, kind: 'pdf',
            data: data, mime: 'application/pdf', pageCount: count, thumbs: {}
          };
          state.files.push(file);
          for (var p = 1; p <= count; p++) {
            state.items.push({ uid: 'i' + nextId(), fileId: file.id, page: p, rotation: 0 });
          }
        } else if (/\.(jpe?g|png)$/.test(lower) || /^image\/(jpe?g|png)$/.test(f.type || '')) {
          var bytes = new Uint8Array(await f.arrayBuffer());
          var mime = (/\.png$/.test(lower) || f.type === 'image/png') ? 'image/png' : 'image/jpeg';
          var file2 = {
            id: 'f' + nextId(), name: f.name, kind: 'image',
            data: bytes, mime: mime, pageCount: 1,
            thumbs: { 1: URL.createObjectURL(new Blob([bytes], { type: mime })) }
          };
          state.files.push(file2);
          state.items.push({ uid: 'i' + nextId(), fileId: file2.id, page: 1, rotation: 0 });
        } else {
          skipped.push(f.name);
        }
      } catch (e) {
        skipped.push(f.name + (e && e.message ? '（' + e.message + '）' : ''));
      }
    }
    if (skipped.length) {
      A.setStatus('已跳过：' + skipped.slice(0, 3).join('、') + (skipped.length > 3 ? ' 等 ' + skipped.length + ' 个' : ''), 'err');
    }
    renderBoard();
    enqueueThumbs();
  }

  async function pageCount(data) {
    var doc = await global.PDFLib.PDFDocument.load(data, { ignoreEncryption: true });
    return doc.getPageCount();
  }

  /* ─────────── 画板渲染 ─────────── */

  function opBtn(act, title, svg) {
    var b = document.createElement('button');
    b.type = 'button';
    b.dataset.act = act;
    b.title = title;
    b.innerHTML = svg;
    return b;
  }

  function renderBoard() {
    var board = A.$('#merge-board');
    board.textContent = '';
    var has = state.items.length > 0;
    A.$('#merge-toolbar').hidden = !has;
    A.$('#run-merge').disabled = !has;
    A.$('#merge-count').textContent = has
      ? state.files.length + ' 个文件 · ' + state.items.length + ' 个页面'
      : '';

    state.items.forEach(function (it, pos) {
      var file = fileOf(it.fileId);
      if (!file) return;

      var card = document.createElement('div');
      card.className = 'mcard' + (file.kind === 'image' ? ' is-img' : '');
      card.dataset.uid = it.uid;
      card.dataset.file = file.id;
      card.dataset.page = String(it.page);
      card.dataset.rot = String(it.rotation);
      card.draggable = true;

      var badge = document.createElement('span');
      badge.className = 'idx';
      badge.textContent = String(pos + 1);
      card.appendChild(badge);

      var thumb = document.createElement('div');
      thumb.className = 'thumb';
      var url = file.thumbs && file.thumbs[it.page];
      if (url) {
        var img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        img.draggable = false;
        thumb.appendChild(img);
      } else {
        thumb.classList.add('pending');
        thumb.textContent = url === '' ? '×' : '…';
      }
      card.appendChild(thumb);

      var src = document.createElement('div');
      src.className = 'src';
      src.textContent = file.kind === 'image' ? file.name : file.name + ' · 第' + it.page + '页';
      src.title = src.textContent;
      card.appendChild(src);

      var ops = document.createElement('div');
      ops.className = 'ops';
      ops.appendChild(opBtn('rot', '旋转 90°',
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>'));
      ops.appendChild(opBtn('dup', '复制本页',
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>'));
      ops.appendChild(opBtn('del', '删除本页',
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6.5 7l1 13h9l1-13"/></svg>'));
      ops.addEventListener('click', function (e) {
        var btn = e.target.closest('button');
        if (!btn) return;
        var idx = itemIndex(it.uid);
        if (idx < 0) return;
        var act = btn.dataset.act;
        if (act === 'rot') {
          it.rotation = (it.rotation + 90) % 360;
          card.dataset.rot = String(it.rotation);
        } else if (act === 'dup') {
          state.items.splice(idx + 1, 0,
            { uid: 'i' + nextId(), fileId: it.fileId, page: it.page, rotation: it.rotation });
          renderBoard();
        } else if (act === 'del') {
          state.items.splice(idx, 1);
          pruneFiles();
          renderBoard();
        }
      });
      card.appendChild(ops);

      card.addEventListener('dragstart', function (e) {
        dragUid = it.uid;
        card.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', it.uid); } catch (err) { /* 忽略 */ }
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', function () {
        dragUid = null;
        card.classList.remove('dragging');
        clearDropMarks();
      });

      board.appendChild(card);
    });
  }

  /* ─────────── 拖拽排序 ─────────── */

  var dragUid = null;

  function clearDropMarks() {
    A.$$('.mcard').forEach(function (c) {
      c.classList.remove('drop-before', 'drop-after');
    });
  }

  function wireBoardDnd() {
    var board = A.$('#merge-board');
    board.addEventListener('dragover', function (e) {
      // 无条件拦默认：外部文件拖到画板上松手不能让 webview 导航走
      e.preventDefault();
      if (!dragUid) return;
      e.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      var card = e.target.closest('.mcard');
      if (!card || card.dataset.uid === dragUid) return;
      var rect = card.getBoundingClientRect();
      var before = (e.clientX - rect.left) < rect.width / 2;
      card.classList.add(before ? 'drop-before' : 'drop-after');
    });
    board.addEventListener('drop', function (e) {
      e.preventDefault();
      if (!dragUid) return;
      var card = e.target.closest('.mcard');
      var from = itemIndex(dragUid);
      if (from < 0) return;
      // 拖起又放回自身卡片：无操作（先 splice 会查不到自身 uid，误落"移到末尾"分支）
      if (card && card.dataset.uid === dragUid) {
        dragUid = null;
        clearDropMarks();
        return;
      }
      var moved = state.items.splice(from, 1)[0];
      if (!card) {
        state.items.push(moved); // 拖到空白处 → 移到末尾
      } else {
        var rect = card.getBoundingClientRect();
        var before = (e.clientX - rect.left) < rect.width / 2;
        var to = itemIndex(card.dataset.uid);
        if (to < 0) state.items.push(moved);
        else state.items.splice(before ? to : to + 1, 0, moved);
      }
      dragUid = null;
      clearDropMarks();
      renderBoard();
    });
  }

  /* ─────────── 缩略图渲染队列 ─────────── */

  var thumbQueue = [];
  var thumbBusy = false;
  var thumbFails = {}; // key -> 连续失败次数（失败页最多重试 2 次，防反复入队空转）

  function enqueueThumbs() {
    state.items.forEach(function (it) {
      var file = fileOf(it.fileId);
      if (!file || file.kind !== 'pdf') return;
      if (file.thumbs[it.page] !== undefined) return; // '' 是失败哨兵，也算已处理
      var key = file.id + ':' + it.page;
      if ((thumbFails[key] || 0) >= 2) return;
      if (thumbQueue.indexOf(key) < 0) thumbQueue.push(key);
    });
    pumpThumbs();
  }

  async function pumpThumbs() {
    if (thumbBusy) return;
    thumbBusy = true;
    try {
      var docs = {}; // fileId -> pdf.js 文档
      while (thumbQueue.length) {
        var key = thumbQueue.shift();
        var parts = key.split(':');
        var fid = parts[0], pageNum = parseInt(parts[1], 10);
        var file = fileOf(fid);
        if (!file || file.kind !== 'pdf' || file.thumbs[pageNum] !== undefined) continue;
        try {
          if (!docs[fid]) docs[fid] = await E.openDoc(file.data);
          var canvas = await E.renderPage(docs[fid], pageNum, 132 / 595);
          file.thumbs[pageNum] = canvas.toDataURL('image/jpeg', 0.75);
          canvas.width = 0; canvas.height = 0;
          paintThumb(fid, pageNum, file.thumbs[pageNum]);
        } catch (e) {
          file.thumbs[pageNum] = '';
          thumbFails[key] = (thumbFails[key] || 0) + 1;
          paintThumb(fid, pageNum, '');
        }
        await new Promise(function (r) { setTimeout(r, 0); });
      }
      for (var k in docs) {
        try { docs[k].destroy(); } catch (e) { /* 忽略 */ }
      }
    } finally {
      thumbBusy = false;
    }
  }

  function paintThumb(fileId, pageNum, url) {
    var cards = document.querySelectorAll('.mcard[data-file="' + fileId + '"][data-page="' + pageNum + '"] .thumb');
    for (var i = 0; i < cards.length; i++) {
      var thumb = cards[i];
      if (url) {
        thumb.classList.remove('pending');
        thumb.textContent = '';
        var img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.draggable = false;
        thumb.appendChild(img);
      } else {
        thumb.textContent = '×';
      }
    }
  }

  /* ─────────── 合并执行 ─────────── */

  async function run() {
    if (!state.items.length) { A.setStatus('请先添加 PDF 或图片文件', 'err'); return; }
    var btn = A.$('#run-merge');
    btn.disabled = true;
    A.progShow('merge', '合并中…');
    try {
      var inputs = state.files.map(function (f) {
        return { kind: f.kind, data: f.data, mime: f.mime };
      });
      var plan = state.items.map(function (it) {
        var file = fileOf(it.fileId);
        var idx = state.files.indexOf(file);
        return file.kind === 'image'
          ? { kind: 'image', input: idx, rotation: it.rotation }
          : { kind: 'pdf', input: idx, page: it.page, rotation: it.rotation };
      });
      var r = await E.mergeFromPlan(inputs, plan, function (done, total) {
        A.progUpdate('merge', '合并 ' + done + '/' + total + ' 页', done / total * 100);
      });
      A.showRows('merge', [{
        name: '合并_' + A.stamp() + '.pdf',
        bytes: r.bytes,
        meta: plan.length + ' 页 · ' + A.fmtSize(r.bytes.byteLength)
      }]);
      A.setStatus('合并完成', 'ok');
      A.notify('PDF 合并完成', '共 ' + plan.length + ' 页，请保存');
    } finally {
      A.progHide('merge');
      btn.disabled = false;
    }
  }

  /* ─────────── 导出 ─────────── */

  global.MergeTool = { init: init };
})(typeof window !== 'undefined' ? window : globalThis);