'use strict';
/* vim 键位层:挂到 <textarea> 上的 NORMAL/INSERT 两态编辑 + : 命令行(w / q / wq / q!)。
 *
 * 约束:
 * - 所有文本改动走 document.execCommand('delete' / 'insertText'),保住 textarea
 *   的原生 undo 栈 —— u 就是 execCommand('undo'),与手动打字共用一条历史。
 * - NORMAL 态下未映射的可打印键一律吞掉(不该落进文本);Ctrl/Meta/Alt 组合键放行,
 *   复制/粘贴/全选照常,仅 Ctrl+R 映射为 redo。
 * - 故意不做:数字倍率、可视模式、/ 搜索、多寄存器。支持的键位见页面帮助。
 * - IME 组合中(isComposing)不截获任何键。
 *
 * 用法:
 *   const vim = attachVim(ta, {
 *     onMode(m)      // m: 'normal' | 'insert',切换指示器
 *     onSave()       // :w / :wq
 *     onClose(force) // :q(false,允许页面拦截) / :q! / :wq(true)
 *     message(msg)   // 提示(未映射键说明等)
 *     cmdInput,      // ':' 命令输入框(其父元素带 .vimcmd,回车执行、Esc 收起)
 *   });
 *   vim.detach();
 */
function attachVim(ta, hooks) {
  let mode = 'normal';
  let reg = '';          // 行级 yank 寄存器(总是带换行)
  let wantCol = 0;       // j/k 记忆列(横向移动时更新)
  let pendingG = false;  // gg 前奏
  let pendingOp = '';    // 'd' | 'y' 等待第二键
  let detached = false;

  const api = {
    mode: () => mode,
    command: runCommand,
    detach() {
      if (detached) return;
      detached = true;
      ta.removeEventListener('keydown', onKey);
      if (hooks.cmdInput) {
        hooks.cmdInput.removeEventListener('keydown', onCmdKey);
        hooks.cmdInput.removeEventListener('blur', onCmdBlur);
      }
    },
  };

  /* ── 基础工具 ─────────────────────────── */
  const caret = () => ta.selectionStart;

  function lineBounds() {
    const v = ta.value, starts = [0];
    for (let i = 0; i < v.length; i++) {
      if (v.charCodeAt(i) === 10) starts.push(i + 1);
    }
    return starts;
  }

  /* pos 所在行 → [行首, 行尾(\n 之前), 行号] */
  function lineOf(pos) {
    const starts = lineBounds();
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    const end = lo + 1 < starts.length ? starts[lo + 1] - 1 : ta.value.length;
    return [starts[lo], end, lo];
  }

  function setSel(s, e) { ta.setSelectionRange(s, e); }
  /* 横向定位:更新 wantCol */
  function setCaret(pos) {
    const [ls] = lineOf(pos);
    wantCol = pos - ls;
    setSel(pos, pos);
  }
  /* 纵向落点:不动 wantCol(穿过短行时保留列记忆) */
  function rawCaret(pos) { setSel(pos, pos); }

  /* 替换 [s,e) 为 text(经 execCommand,保住原生 undo 栈) */
  function splice(s, e, text) {
    setSel(s, e);
    if (s === e) {
      if (text) document.execCommand('insertText', false, text);
    } else if (text) {
      document.execCommand('insertText', false, text);
    } else {
      document.execCommand('delete');
    }
  }

  /* ── 单词动作 ─────────────────────────── */
  function wclass(ch) {
    if (ch === undefined || ch === '') return 'space';
    if (/[ \t\r\n]/.test(ch)) return 'space';
    if (/[A-Za-z0-9_]/.test(ch)) return 'word';
    return 'punct';
  }
  function motionW(pos) {
    const v = ta.value;
    let i = Math.min(pos, v.length);
    if (i >= v.length) return i;
    const cls = wclass(v[i]);
    if (cls !== 'space') while (i < v.length && wclass(v[i]) === cls) i++;
    while (i < v.length && wclass(v[i]) === 'space') i++;
    return i;
  }
  function motionB(pos) {
    const v = ta.value;
    let i = Math.max(0, pos - 1);
    while (i > 0 && wclass(v[i]) === 'space') i--;
    const cls = wclass(v[i]);
    while (i > 0 && wclass(v[i - 1]) === cls && cls !== 'space') i--;
    return i;
  }
  function motionE(pos) {
    const v = ta.value;
    if (pos + 1 >= v.length) return Math.max(0, v.length - 1);
    let i = pos + 1;
    while (i < v.length && wclass(v[i]) === 'space') i++;
    if (i >= v.length) return v.length - 1;
    const cls = wclass(v[i]);
    while (i + 1 < v.length && wclass(v[i + 1]) === cls) i++;
    return i;
  }

  /* ── 行动作 ──────────────────────────── */
  function moveVert(d) {
    const [, , li] = lineOf(caret());
    const starts = lineBounds();
    const ni = Math.max(0, Math.min(starts.length - 1, li + d));
    if (ni === li) return;
    const nls = starts[ni];
    const nle = ni + 1 < starts.length ? starts[ni + 1] - 1 : ta.value.length;
    rawCaret(nls + Math.min(wantCol, nle - nls));
  }
  function lineStartNonBlank(ls, le) {
    const v = ta.value;
    let p = ls;
    while (p < le && (v[p] === ' ' || v[p] === '\t')) p++;
    return p;
  }
  /* 当前行入寄存器;返回 [ls, le, hasNl] */
  function yankLine() {
    const v = ta.value;
    const [ls, le] = lineOf(caret());
    reg = v.slice(ls, le) + '\n';
    return [ls, le, le < v.length];
  }
  function deleteLine() {
    const [ls, le, hasNl] = yankLine();
    if (hasNl) splice(ls, le + 1, '');
    else if (ls > 0) splice(ls - 1, le, '');
    else splice(0, le, '');
    rawCaret(Math.min(ls, ta.value.length));
  }
  function pasteLine(after) {
    if (!reg) {
      hooks.message && hooks.message('寄存器为空,先用 yy 复制一行');
      return;
    }
    const v = ta.value;
    const [ls, le] = lineOf(caret());
    const hasNl = le < v.length; /* lineOf 第三个返回值是行号,行尾判定必须单独算 */
    let pos, text;
    if (after) {
      if (!v) { pos = 0; text = reg.slice(0, -1); }
      else if (hasNl) { pos = le + 1; text = reg; }
      else { pos = v.length; text = '\n' + reg.slice(0, -1); }
    } else {
      pos = ls; text = reg;
    }
    splice(pos, pos, text);
    rawCaret(pos + (after && !v ? 0 : after && !hasNl ? 1 : 0));
  }

  /* ── 模式 ────────────────────────────── */
  function setMode(m) {
    if (mode === m) return;
    mode = m;
    setSel(caret(), caret());
    hideCmd();
    hooks.onMode && hooks.onMode(m);
  }

  /* ── : 命令行 ────────────────────────── */
  function onCmdKey(e) {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const val = hooks.cmdInput.value;
      hideCmd();
      ta.focus();
      runCommand(val);
    } else if (e.key === 'Escape') {
      hideCmd();
      ta.focus();
    }
  }
  function onCmdBlur() { hideCmd(); }
  function hideCmd() {
    if (hooks.cmdInput && hooks.cmdInput.parentElement) {
      hooks.cmdInput.parentElement.classList.add('hidden');
    }
  }
  function showCmd() {
    if (!hooks.cmdInput) return;
    hooks.cmdInput.parentElement.classList.remove('hidden');
    hooks.cmdInput.value = '';
    hooks.cmdInput.focus();
  }
  function runCommand(raw) {
    const c = String(raw || '').trim().replace(/^:+/, '');
    if (c === 'w' || c === 'write') {
      hooks.onSave && hooks.onSave();
    } else if (c === 'wq' || c === 'x') {
      /* 保存成功才关抽屉;onSave 返回 false(校验拦截/rpc 失败)时保持打开,防丢未保存内容 */
      const r = hooks.onSave && hooks.onSave();
      if (r && typeof r.then === 'function') {
        r.then(ok => { if (ok !== false && hooks.onClose) hooks.onClose(true); });
      } else if (r !== false && hooks.onClose) {
        hooks.onClose(true);
      }
    } else if (c === 'q') {
      hooks.onClose && hooks.onClose(false);
    } else if (c === 'q!') {
      hooks.onClose && hooks.onClose(true);
    } else if (c) {
      hooks.message && hooks.message('未知命令: ' + c + '(支持 w / q / wq / q!)');
    }
  }

  /* ── 键分发 ──────────────────────────── */
  function onKey(e) {
    if (e.isComposing || e.defaultPrevented || detached) return;
    if (mode === 'insert') {
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setMode('normal');
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        document.execCommand('redo');
      }
      return;
    }
    const k = e.key;
    const v = ta.value;
    const c = caret();
    const [ls, le] = lineOf(c);
    let used = true;

    /* 操作符第二键(dd / dw / yy) */
    if (pendingOp) {
      const op = pendingOp;
      pendingOp = '';
      if (k === op && op === 'd') deleteLine();
      else if (k === op && op === 'y') {
        yankLine();
        hooks.message && hooks.message('已复制 1 行');
      } else if (op === 'd' && k === 'w') {
        const cap = le < v.length ? le + 1 : le;
        const m = Math.min(motionW(c), cap);
        if (m > c) splice(c, m, '');
      }
      e.preventDefault();
      return;
    }
    if (pendingG) {
      pendingG = false;
      if (k === 'g') setCaret(0);
      else if (k === 'v' || k === 'V') hooks.message && hooks.message('不支持可视模式');
      else used = false;
      if (used) e.preventDefault();
      return;
    }

    switch (k) {
      case 'Escape': break; /* 已在 NORMAL */
      case 'i': setMode('insert'); break;
      case 'I': rawCaret(lineStartNonBlank(ls, le)); setMode('insert'); break;
      case 'a': rawCaret(c < le ? c + 1 : le); setMode('insert'); break;
      case 'A': rawCaret(le); setMode('insert'); break;
      case 'o': splice(le, le, '\n'); rawCaret(le + 1); setMode('insert'); break;
      case 'O': splice(ls, ls, '\n'); rawCaret(ls); setMode('insert'); break;
      case 'h': setCaret(Math.max(ls, c - 1)); break;
      case 'l': setCaret(Math.min(le, c + 1)); break;
      case 'j': moveVert(1); break;
      case 'k': moveVert(-1); break;
      case '0': setCaret(ls); break;
      case '^': setCaret(lineStartNonBlank(ls, le)); break;
      case '$': setCaret(le > ls ? le - 1 : ls); break;
      case 'g': pendingG = true; break;
      case 'G': {
        const starts = lineBounds();
        let li = starts.length - 1;
        /* 文件以换行结尾时,末尾的"虚拟空行"不算——落到最后一个真实行(vim 语义) */
        if (li > 0 && starts[li] >= ta.value.length && ta.value.endsWith('\n')) li--;
        const gls = starts[li];
        const gle = li + 1 < starts.length ? starts[li + 1] - 1 : ta.value.length;
        setCaret(lineStartNonBlank(gls, gle));
        break;
      }
      case 'w': setCaret(motionW(c)); break;
      case 'b': setCaret(motionB(c)); break;
      case 'e': setCaret(motionE(c)); break;
      case 'x':
        if (c < le) splice(c, c + 1, ''); /* 空行/行尾不动(vim 同) */
        break;
      case 'd': case 'y': pendingOp = k; break;
      case 'p': pasteLine(true); break;
      case 'P': pasteLine(false); break;
      case 'u': document.execCommand('undo'); break;
      case ' ': setCaret(Math.min(le, c + 1)); break;
      case 'Enter': moveVert(1); break;
      case ':': showCmd(); break;
      case 'Backspace': case 'Delete': case 'Tab': break; /* 吞掉:编辑走 x/dd */
      default:
        if (k.length === 1) break; /* 未映射可打印键:NORMAL 态不落文本 */
        used = false; /* 功能键放行 */
    }
    if (used) e.preventDefault();
  }

  ta.addEventListener('keydown', onKey);
  if (hooks.cmdInput) {
    hooks.cmdInput.addEventListener('keydown', onCmdKey);
    hooks.cmdInput.addEventListener('blur', onCmdBlur);
    hideCmd();
  }
  hooks.onMode && hooks.onMode(mode);
  return api;
}