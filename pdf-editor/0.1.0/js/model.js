/* model.js — 覆盖物/页/草稿的工厂、校验与序列化（schema v1，纯函数，Node 可测）
 *
 * 拍板要点（架构 §5）：
 * - 白盒不是独立类型：shape.kind="rect" + fill="#ffffff" 的语法糖（makeWhiteout）。
 * - z 序为显式字段（页内绘制序，大者在上），配合命令快照最小 diff。
 * - 页删除 = 物理移除 + history pageList 快照撤销；schema 不设 deleted 字段。
 * - 坐标语义见 geometry.js 头注释：局部 CropBox 空间（pt，左下原点，Y 向上）。
 *
 * @see [架构方案 §5.2](../../../docs/插件开发/PDF编辑器-架构方案.md)
 *
 * 本文件不依赖 DOM/vendor 全局做顶层初始化，可在 Node 沙箱加载。
 */
(function (global) {
  'use strict';

  var PDFED = global.PDFED = global.PDFED || {};

  var SCHEMA_VERSION = 1;
  var OVERLAY_TYPES = ['text', 'image', 'shape', 'ink', 'signature'];
  var SHAPE_KINDS = ['rect', 'ellipse', 'highlight'];
  var ALIGN = ['left', 'center', 'right'];
  var FONT_SIZE_MIN = 4, FONT_SIZE_MAX = 128;
  var COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  /* ── 基础工具 ── */

  /** 深拷贝：模型对象均为 JSON-safe（不含 undefined/函数），JSON 往返足够。 */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function isPlainObj(o) {
    return !!o && typeof o === 'object' && !Array.isArray(o);
  }
  function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }
  function isId(v, prefix) {
    return typeof v === 'string' && new RegExp('^' + prefix + '_\\d+$').test(v);
  }

  /* ── id 生成：草稿内计数器，跨会话续号 ── */

  function nextId(draft, kind) {
    if (!draft.counters) draft.counters = { ov: 0, pg: 0, as: 0 };
    draft.counters[kind] = (draft.counters[kind] || 0) + 1;
    return kind + '_' + draft.counters[kind];
  }

  /** 草稿恢复后按现存对象续号，防 id 冲突（恢复会话再新建对象时用）。 */
  function recount(draft) {
    var c = { ov: 0, pg: 0, as: 0 };
    (draft.pages || []).forEach(function (p) {
      var m = /^pg_(\d+)$/.exec(p.id); if (m) c.pg = Math.max(c.pg, +m[1]);
    });
    (draft.overlays || []).forEach(function (o) {
      var m = /^ov_(\d+)$/.exec(o.id); if (m) c.ov = Math.max(c.ov, +m[1]);
    });
    Object.keys(draft.assets || {}).forEach(function (k) {
      var m = /^as_(\d+)$/.exec(k); if (m) c.as = Math.max(c.as, +m[1]);
    });
    draft.counters = c;
    return draft;
  }

  /* ── 工厂 ── */

  function makeDraft(opts) {
    return {
      schema: SCHEMA_VERSION,
      docId: String(opts.docId || ''),
      origName: String(opts.origName || ''),
      savedAt: null,
      counters: { ov: 0, pg: 0, as: 0 },
      pages: [],
      overlays: [],
      assets: {}
    };
  }

  /** Page：srcIndex 为 null 表示新空白页（P1）；rotateDelta 相对原页 /Rotate 的增量。 */
  function makePage(opts) {
    return {
      id: null,                       // 由调用方经 nextId(draft,'pg') 填
      srcIndex: (opts && opts.srcIndex != null) ? opts.srcIndex : null,
      rotateDelta: (opts && opts.rotateDelta) || 0
    };
  }

  /** 通用覆盖物工厂：type 决定子对象默认值；patch 覆盖默认。 */
  function makeOverlay(type, patch) {
    var o = {
      id: null,                       // 由调用方经 nextId(draft,'ov') 填
      type: type,
      pageId: (patch && patch.pageId) || null,
      x: 0, y: 0, w: 0, h: 0,         // pt，页局部空间，(x,y)=左下角
      rotate: 0,                      // P0 恒 0，字段预留 P1
      z: 0,                           // 页内绘制序，大者在上
      opacity: 1, locked: false,
      anchor: null                    // 「点原文建白盒」溯源提示 {sample, at}
    };
    if (type === 'text') {
      o.text = {
        value: '',
        fontSize: 12, lineHeight: 1.45, color: '#111111',
        align: 'left', bold: false, fontKey: 'notosc',
        lines: null                   // 行烘焙结果（失焦提交时写入），见架构 §7.2
      };
    } else if (type === 'image' || type === 'signature') {
      o.image = { assetId: null, naturalW: 0, naturalH: 0 };
    } else if (type === 'shape') {
      o.shape = { kind: 'rect', fill: '#ffffff', fillOpacity: 1, stroke: null, strokeWidth: 0 };
    } else if (type === 'ink') {
      o.ink = { points: [], stroke: '#111111', strokeWidth: 2 };
    }
    if (patch) {
      ['pageId', 'x', 'y', 'w', 'h', 'rotate', 'z', 'opacity', 'locked', 'anchor'].forEach(function (k) {
        if (patch[k] !== undefined) o[k] = patch[k];
      });
      if (patch.text) { Object.keys(patch.text).forEach(function (k) { o.text[k] = patch.text[k]; }); }
      if (patch.image) { Object.keys(patch.image).forEach(function (k) { o.image[k] = patch.image[k]; }); }
      if (patch.shape) { Object.keys(patch.shape).forEach(function (k) { o.shape[k] = patch.shape[k]; }); }
      if (patch.ink) { Object.keys(patch.ink).forEach(function (k) { o.ink[k] = patch.ink[k]; }); }
    }
    return o;
  }

  /** 白盒糖：白底矩形遮盖原文（编辑器核心交互元素）。 */
  function makeWhiteout(pageId, rect, z) {
    return makeOverlay('shape', {
      pageId: pageId, x: rect.x, y: rect.y, w: rect.w, h: rect.h, z: z,
      shape: { kind: 'rect', fill: '#ffffff', fillOpacity: 1, stroke: null, strokeWidth: 0 }
    });
  }

  /** 高亮：半透明色块（默认荧光黄，导出 fillOpacity 0.35 由形状 kind 语义决定）。 */
  function makeHighlight(pageId, rect, z, color) {
    return makeOverlay('shape', {
      pageId: pageId, x: rect.x, y: rect.y, w: rect.w, h: rect.h, z: z,
      shape: { kind: 'highlight', fill: color || '#ffe066', fillOpacity: 0.35, stroke: null, strokeWidth: 0 }
    });
  }

  /* ── 校验（返回中文错误数组；空数组 = 合法） ── */

  function validateOverlay(o) {
    var errs = [];
    if (!isPlainObj(o)) return ['覆盖物不是对象'];
    if (!isId(o.id, 'ov')) errs.push('覆盖物 id 非法：' + JSON.stringify(o.id));
    if (OVERLAY_TYPES.indexOf(o.type) < 0) errs.push('未知覆盖物类型：' + o.type);
    if (!isId(o.pageId, 'pg')) errs.push('覆盖物 pageId 非法：' + JSON.stringify(o.pageId));
    ['x', 'y', 'w', 'h'].forEach(function (k) {
      if (!isFiniteNum(o[k]) || o[k] < 0) errs.push('覆盖物 ' + k + ' 非法：' + o[k]);
    });
    if (!isFiniteNum(o.z) || o.z < 0 || (o.z | 0) !== o.z) errs.push('覆盖物 z 序非法：' + o.z);
    if (!isFiniteNum(o.opacity) || o.opacity < 0 || o.opacity > 1) errs.push('透明度非法：' + o.opacity);
    if (o.rotate !== 0) errs.push('schema v1 不支持元素级旋转：' + o.rotate);
    if (o.type === 'text') {
      if (!isPlainObj(o.text)) { errs.push('text 覆盖物缺少 text 子对象'); return errs; }
      if (typeof o.text.value !== 'string') errs.push('text.value 非法');
      if (!isFiniteNum(o.text.fontSize) || o.text.fontSize < FONT_SIZE_MIN || o.text.fontSize > FONT_SIZE_MAX)
        errs.push('字号超出 ' + FONT_SIZE_MIN + '-' + FONT_SIZE_MAX + '：' + o.text.fontSize);
      if (ALIGN.indexOf(o.text.align) < 0) errs.push('对齐非法：' + o.text.align);
      if (o.text.color && !COLOR_RE.test(o.text.color)) errs.push('文字颜色非法：' + o.text.color);
      if (o.text.lines != null) {
        if (!Array.isArray(o.text.lines)) errs.push('行烘焙 lines 非法');
        else o.text.lines.forEach(function (ln, i) {
          if (!isPlainObj(ln) || typeof ln.text !== 'string' || !isFiniteNum(ln.baseY))
            errs.push('第 ' + (i + 1) + ' 行烘焙数据非法');
        });
      }
    } else if (o.type === 'image' || o.type === 'signature') {
      if (!isPlainObj(o.image) || !isId(o.image.assetId, 'as')) errs.push('图片覆盖物缺少有效 assetId');
    } else if (o.type === 'shape') {
      if (!isPlainObj(o.shape) || SHAPE_KINDS.indexOf(o.shape.kind) < 0) errs.push('形状 kind 非法：' + (o.shape && o.shape.kind));
      else if (o.shape.kind !== 'rect' && !o.shape.fill) errs.push('形状缺少填充色：' + o.shape.kind);
    } else if (o.type === 'ink') {
      if (!isPlainObj(o.ink) || !Array.isArray(o.ink.points) || o.ink.points.length < 2)
        errs.push('笔迹点数不足');
    }
    return errs;
  }

  function validateDraft(d) {
    var errs = [];
    if (!isPlainObj(d)) return ['草稿不是对象'];
    if (d.schema !== SCHEMA_VERSION) return ['未知草稿 schema：' + d.schema + '（本插件支持 v' + SCHEMA_VERSION + '）'];
    if (typeof d.docId !== 'string' || !/^[0-9a-f]{16}$/.test(d.docId)) errs.push('docId 非法（应为 16 位 hex）');
    var pageIds = {};
    (d.pages || []).forEach(function (p, i) {
      if (!isPlainObj(p) || !isId(p.id, 'pg')) { errs.push('第 ' + (i + 1) + ' 页 id 非法'); return; }
      if (pageIds[p.id]) errs.push('页 id 重复：' + p.id);
      pageIds[p.id] = true;
      if (p.srcIndex != null && !(isFiniteNum(p.srcIndex) && p.srcIndex >= 0)) errs.push('页 ' + p.id + ' srcIndex 非法');
      if ([0, 90, 180, 270].indexOf(p.rotateDelta) < 0) errs.push('页 ' + p.id + ' rotateDelta 非法：' + p.rotateDelta);
    });
    (d.overlays || []).forEach(function (o, i) {
      validateOverlay(o).forEach(function (e) { errs.push('覆盖物 #' + (i + 1) + '：' + e); });
      if (o && o.pageId && !pageIds[o.pageId]) errs.push('覆盖物 #' + (i + 1) + ' 引用了不存在的页：' + o.pageId);
    });
    Object.keys(d.assets || {}).forEach(function (k) {
      var a = d.assets[k];
      if (!isPlainObj(a) || !/^asset:[0-9a-f]{16}$/.test(a.dbKey)) errs.push('asset ' + k + ' 元数据非法');
    });
    return errs;
  }

  /* ── 序列化 ── */

  /** 草稿 → JSON 字符串（模型对象均为 JSON-safe，直接序列化）。 */
  function serializeDraft(d) { return JSON.stringify(d); }

  /** 解析并校验草稿；不合法直接抛中文错误（载入路径不猜不降级）。 */
  function parseDraft(json, opts) {
    var d;
    try { d = JSON.parse(json); } catch (e) { throw new Error('草稿损坏，无法解析'); }
    var errs = validateDraft(d);
    if (errs.length) throw new Error('草稿校验失败：' + errs[0] + (errs.length > 1 ? '（共 ' + errs.length + ' 处）' : ''));
    if (opts && opts.docId && d.docId !== opts.docId)
      throw new Error('草稿与当前文档不匹配（草稿 docId=' + d.docId + '）');
    recount(d);
    return d;
  }

  PDFED.model = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    OVERLAY_TYPES: OVERLAY_TYPES,
    clone: clone,
    nextId: nextId,
    recount: recount,
    makeDraft: makeDraft,
    makePage: makePage,
    makeOverlay: makeOverlay,
    makeWhiteout: makeWhiteout,
    makeHighlight: makeHighlight,
    validateOverlay: validateOverlay,
    validateDraft: validateDraft,
    serializeDraft: serializeDraft,
    parseDraft: parseDraft
  };
})(typeof window !== 'undefined' ? window : globalThis);