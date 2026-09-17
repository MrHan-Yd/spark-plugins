/* commands.js — 撤销/重做命令工厂（纯逻辑，Node 可测）
 *
 * 纪律（架构 §6.4）：
 * - 命令快照一律深拷贝（model.clone）：store 里的对象与撤销栈里的快照不得共享
 *   引用，否则后续命令会改掉栈内 before/after，撤销链被静默污染。
 * - do/undo 一律经 store.change（唯一写口）；history.push 不执行 do——
 *   调用方先提交变更（store.change）再 push，do 仅在 redo 时执行。
 * - update 命令只记录变更字段的 before/after patch（text/shape 子对象内部
 *   同样按字段 patch，与 store 'overlay-update' 的浅合并语义一一对应）。
 *
 * @see [架构方案 §6.4](../../../docs/插件开发/PDF编辑器-架构方案.md)
 *
 * 本文件不依赖 DOM，可在 Node 沙箱加载。
 */
(function (global) {
  'use strict';

  var PDFED = global.PDFED = global.PDFED || {};

  /** 新增覆盖物（可带 asset 元数据登记）。快照入命令，store 内对象独立。 */
  function addOverlay(store, overlay, asset) {
    var snapshot = PDFED.model.clone(overlay);
    return {
      label: '添加' + typeLabel(snapshot),
      do: function () { store.change('overlay-add', { overlay: PDFED.model.clone(snapshot), asset: asset ? PDFED.model.clone(asset) : null }); },
      undo: function () { store.change('overlay-remove', { id: snapshot.id }); }
    };
  }

  /** 删除覆盖物：快照整存整取（对象小，不做字段级 diff）。 */
  function removeOverlay(store, overlay) {
    var snapshot = PDFED.model.clone(overlay);
    return {
      label: '删除' + typeLabel(snapshot),
      do: function () { store.change('overlay-remove', { id: snapshot.id }); },
      undo: function () { store.change('overlay-add', { overlay: PDFED.model.clone(snapshot), asset: null }); }
    };
  }

  /**
   * 字段级更新：before/after 为同构 patch（顶层字段或 text./shape. 子键）。
   * 拖动/文本输入在提交点构造一次，指针中间态不进栈。
   */
  function updateOverlay(store, id, beforePatch, afterPatch, label) {
    var before = PDFED.model.clone(beforePatch);
    var after = PDFED.model.clone(afterPatch);
    return {
      label: label || '修改',
      do: function () { store.change('overlay-update', { id: id, patch: PDFED.model.clone(after) }); },
      undo: function () { store.change('overlay-update', { id: id, patch: PDFED.model.clone(before) }); }
    };
  }

  /** 页序整体替换（页面级操作频率低，before/after 两份 Page 数组快照整存）。 */
  function setPageList(store, beforePages, afterPages, label) {
    var before = PDFED.model.clone(beforePages);
    var after = PDFED.model.clone(afterPages);
    return {
      label: label || '页面操作',
      do: function () { store.change('pages-set', { pages: PDFED.model.clone(after) }); },
      undo: function () { store.change('pages-set', { pages: PDFED.model.clone(before) }); }
    };
  }

  function typeLabel(o) {
    return { text: '文本框', image: '图片', shape: '形状', ink: '笔迹', signature: '签名' }[o.type] || '对象';
  }

  PDFED.commands = {
    addOverlay: addOverlay,
    removeOverlay: removeOverlay,
    updateOverlay: updateOverlay,
    setPageList: setPageList
  };
})(typeof window !== 'undefined' ? window : globalThis);