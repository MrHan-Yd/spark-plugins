/* store.js — 集中状态 + topic 订阅，唯一写口 change()（Node 可测）
 *
 * 设计（架构 ADR-3）：
 * - 无框架：手写集中 store，视图层订阅 topic 后全量重排自己关心的 DOM
 *   （页内对象 <1k，全量重排成本可接受；精细 diff 的复杂度不需要）。
 * - 唯一写口 = change(kind, payload)：命令的 do/undo 也必须走它，保证 dirty
 *   标记、广播与持久化钩子单点收口；视图层禁止直接改 state 字段。
 * - state 只存可序列化编辑态；pdf.js 文档对象与原始字节归 render/shell 持有，
 *   store 不碰（doc 元数据 docId/origName/pageCount 除外）。
 *
 * @see [架构方案 §1.1/§5](../../../docs/插件开发/PDF编辑器-架构方案.md)
 *
 * 本文件不依赖 DOM，可在 Node 沙箱加载。
 */
(function (global) {
  'use strict';

  var PDFED = global.PDFED = global.PDFED || {};

  var TOPICS = ['doc', 'pages', 'overlays', 'selection', 'meta', 'save'];

  function createStore(initial) {
    var state = initial || {
      /* 文档元信息（可序列化部分；bytes/pdfDoc 由 render/shell 自持） */
      doc: null,                    // { docId, origName, pageCount }
      pages: [],                    // model.Page[]
      overlays: [],                 // model.Overlay[]（数组序 + 显式 z 双轨）
      assets: {},                   // id → Asset 元数据（字节在 spark.db）
      selection: [],                // 选中 overlay id[]
      activePageId: null,
      mode: 'start',                // start | text | shape | page | view
      zoom: 1,
      fit: 'none',                  // none | width | page
      dirty: false,
      savedAt: null
    };
    var subs = {};                  // topic → Set<fn>
    TOPICS.forEach(function (t) { subs[t] = new Set(); });

    function subscribe(topic, fn) {
      if (!subs[topic]) throw new Error('store: 未知 topic ' + topic);
      subs[topic].add(fn);
      return function () { subs[topic].delete(fn); };
    }

    function emit(topic) {
      subs[topic].forEach(function (fn) { fn(state); });
    }

    /* ── 原语变更（唯一写口） ── */

    function markDirty() {
      if (!state.dirty) state.dirty = true;
    }

    var mutators = {
      /* 打开/关闭文档：元信息 + 初始页序；不标 dirty（新会话起点） */
      'doc-open': function (p) {
        state.doc = p.doc;
        state.pages = p.pages || [];
        state.overlays = [];
        state.assets = {};
        state.selection = [];
        state.dirty = false;
        state.savedAt = null;
        state.activePageId = state.pages.length ? state.pages[0].id : null;
      },
      'doc-close': function () {
        state.doc = null;
        state.pages = [];
        state.overlays = [];
        state.assets = {};
        state.selection = [];
        state.dirty = false;
        state.activePageId = null;
        state.mode = 'start';
      },
      'pages-set': function (p) {
        state.pages = p.pages;
        markDirty();
      },
      'overlay-add': function (p) {
        state.overlays.push(p.overlay);
        if (p.asset) state.assets[p.overlay.image.assetId] = p.asset;
        markDirty();
      },
      'overlay-remove': function (p) {
        var i = state.overlays.findIndex(function (o) { return o.id === p.id; });
        if (i >= 0) state.overlays.splice(i, 1);
        if (state.selection.indexOf(p.id) >= 0)
          state.selection = state.selection.filter(function (s) { return s !== p.id; });
        markDirty();
      },
      /* 浅合并 patch：字段级命令（架构 update 粒度），引用替换由命令层深拷贝 */
      'overlay-update': function (p) {
        var o = state.overlays.find(function (x) { return x.id === p.id; });
        if (!o) throw new Error('store: overlay 不存在 ' + p.id);
        var keys = Object.keys(p.patch);
        if (o.type === 'text' && p.patch.text) {
          Object.keys(p.patch.text).forEach(function (k) { o.text[k] = p.patch.text[k]; });
          keys = keys.filter(function (k) { return k !== 'text'; });
        }
        if (o.type === 'shape' && p.patch.shape) {
          Object.keys(p.patch.shape).forEach(function (k) { o.shape[k] = p.patch.shape[k]; });
          keys = keys.filter(function (k) { return k !== 'shape'; });
        }
        keys.forEach(function (k) { o[k] = p.patch[k]; });
        markDirty();
      },
      'selection-set': function (p) {
        state.selection = (p.ids || []).slice();
      },
      'meta': function (p) {
        var keys = Object.keys(p.patch || {});
        keys.forEach(function (k) { state[k] = p.patch[k]; });
      },
      'save-marked': function () {
        state.dirty = false;
        state.savedAt = Date.now();
      }
    };

    function change(kind, payload) {
      var m = mutators[kind];
      if (!m) throw new Error('store: 未知变更 ' + kind);
      m(payload || {});
      /* 广播面：文档/页/覆盖物/选择/元数据/保存各自治；dirty 随内容 topic 一并带出 */
      switch (kind) {
        case 'doc-open': case 'doc-close': emit('doc'); emit('pages'); emit('overlays'); emit('selection'); break;
        case 'pages-set': emit('pages'); break;
        case 'overlay-add': case 'overlay-remove': case 'overlay-update':
          emit('overlays'); emit('selection'); break;
        case 'selection-set': emit('selection'); break;
        case 'save-marked': emit('save'); break;
        default: emit('meta');
      }
      return state;
    }

    /* ── 选择器（只读视图） ── */

    function pageById(id) {
      return state.pages.find(function (p) { return p.id === id; }) || null;
    }
    function overlayById(id) {
      return state.overlays.find(function (o) { return o.id === id; }) || null;
    }
    function overlaysOfPage(pageId) {
      return state.overlays
        .filter(function (o) { return o.pageId === pageId; })
        .sort(function (a, b) { return a.z - b.z; });
    }
    function topZ(pageId) {
      var arr = state.overlays.filter(function (o) { return o.pageId === pageId; });
      var z = 0;
      arr.forEach(function (o) { if (o.z > z) z = o.z; });
      return z;
    }

    return {
      get: function () { return state; },
      subscribe: subscribe,
      change: change,
      pageById: pageById,
      overlayById: overlayById,
      overlaysOfPage: overlaysOfPage,
      topZ: topZ,
      topics: TOPICS.slice()
    };
  }

  PDFED.store = { createStore: createStore };
})(typeof window !== 'undefined' ? window : globalThis);