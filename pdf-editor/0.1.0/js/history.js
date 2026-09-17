/* history.js — 撤销/重做命令栈（纯数据结构，Node 可测）
 *
 * 设计（架构 §6.4）：
 * - Command = { label, do(), undo(), merge?(next) }；do/undo 为闭包，内部一律经
 *   store.change 执行（唯一写口），history 只管栈序与合并，不触状态。
 * - 栈上限 100（超出丢最旧）；任何新命令清空 redo 栈。
 * - 合并（coalescing）：push(cmd, {coalesceKey, coalesceMs}) 时若栈顶同 key、
 *   在窗口内、且栈顶有 merge()，则栈顶吸收新命令（不执行 do——调用方在提交前
 *   已完成实际变更）；否则入栈。拖动/文本输入只在提交时入栈，天然不会高频。
 *
 * @see [架构方案 §6.4](../../../docs/插件开发/PDF编辑器-架构方案.md)
 *
 * 本文件不依赖 DOM，可在 Node 沙箱加载。
 */
(function (global) {
  'use strict';

  var PDFED = global.PDFED = global.PDFED || {};

  function createHistory(opts) {
    var limit = (opts && opts.limit) || 100;
    var undoStack = [];
    var redoStack = [];

    function push(cmd, coalesce) {
      if (!cmd || typeof cmd.do !== 'function' || typeof cmd.undo !== 'function')
        throw new Error('history: 命令缺少 do/undo');
      if (coalesce && coalesce.coalesceKey && undoStack.length) {
        var top = undoStack[undoStack.length - 1];
        var inWindow = top.coalesceKey === coalesce.coalesceKey &&
          (Date.now() - top.at) <= (coalesce.coalesceMs != null ? coalesce.coalesceMs : 300);
        if (inWindow && typeof top.merge === 'function' && top.merge(cmd, coalesce)) {
          top.at = Date.now();
          return { merged: true };
        }
      }
      cmd.coalesceKey = (coalesce && coalesce.coalesceKey) || null;
      cmd.at = Date.now();
      undoStack.push(cmd);
      if (undoStack.length > limit) undoStack.shift();
      redoStack.length = 0;
      return { merged: false };
    }

    function undo() {
      var cmd = undoStack.pop();
      if (!cmd) return null;
      cmd.undo();
      redoStack.push(cmd);
      return cmd;
    }

    function redo() {
      var cmd = redoStack.pop();
      if (!cmd) return null;
      cmd.do();
      undoStack.push(cmd);
      return cmd;
    }

    return {
      push: push,
      undo: undo,
      redo: redo,
      canUndo: function () { return undoStack.length > 0; },
      canRedo: function () { return redoStack.length > 0; },
      size: function () { return undoStack.length; },
      top: function () { return undoStack[undoStack.length - 1] || null; },
      clear: function () { undoStack.length = 0; redoStack.length = 0; }
    };
  }

  PDFED.history = { createHistory: createHistory };
})(typeof window !== 'undefined' ? window : globalThis);