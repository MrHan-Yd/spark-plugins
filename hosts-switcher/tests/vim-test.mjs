#!/usr/bin/env node
/* vim.js 行为测试:Node 里用 stub textarea + stub document.execCommand 驱动键位层。
 * 运行:`node tests/vim-test.mjs`(开发用,不进发布物)。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, '0.1.0', 'vim.js'), 'utf8');
const attachVim = new Function(src + '\nreturn attachVim;')();

/* ── stub ─────────────────────────────── */
function classList() {
  const s = new Set();
  return {
    add: c => s.add(c),
    remove: c => s.delete(c),
    contains: c => s.has(c),
  };
}
let ta, undoStack, redoStack;
function makeTA(value) {
  undoStack = []; redoStack = [];
  ta = {
    value,
    selectionStart: 0, selectionEnd: 0,
    _h: {},
    focus() { ta._focused = (ta._focused || 0) + 1; },
    addEventListener(t, f) { ta._h[t] = f; },
    removeEventListener(t) { delete ta._h[t]; },
    setSelectionRange(s, e) { ta.selectionStart = s; ta.selectionEnd = e; },
    dispatch(key, mods = {}) {
      const e = { key, isComposing: false, ...mods,
        _pd: false,
        preventDefault() { e._pd = true; },
        stopPropagation() {} };
      if (ta._h.keydown) ta._h.keydown(e);
      return e;
    },
  };
  return ta;
}
globalThis.document = {
  execCommand(cmd, _n, text) {
    if (cmd === 'undo') {
      if (!undoStack.length) return false;
      redoStack.push(ta.value);
      ta.value = undoStack.pop();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      return true;
    }
    if (cmd === 'redo') {
      if (!redoStack.length) return false;
      undoStack.push(ta.value);
      ta.value = redoStack.pop();
      return true;
    }
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (cmd === 'delete') {
      if (s === e) return false;
      undoStack.push(ta.value); redoStack.length = 0;
      ta.value = ta.value.slice(0, s) + ta.value.slice(e);
      ta.setSelectionRange(s, s);
      return true;
    }
    if (cmd === 'insertText') {
      undoStack.push(ta.value); redoStack.length = 0;
      ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
      ta.setSelectionRange(s + text.length, s + text.length);
      return true;
    }
    return false;
  },
};
function makeCmdInput() {
  const ci = {
    value: '',
    focused: 0,
    focus() { ci.focused++; },
    _h: {},
    addEventListener(t, f) { ci._h[t] = f; },
    removeEventListener() {},
    parentElement: { classList: classList() },
    dispatch(key) {
      const e = { key, preventDefault() {}, stopPropagation() {} };
      ci._h.keydown && ci._h.keydown(e);
    },
  };
  return ci;
}

/* ── 断言 ─────────────────────────────── */
let pass = 0, fail = 0;
function eq(actual, want, label) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  if (a === w) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log(`  FAIL  ${label}\n        want ${w}\n        got  ${a}`); }
}

function setup(value) {
  const t = makeTA(value);
  const cmd = makeCmdInput();
  const hooks = { modes: [], saved: 0, closed: [], msgs: [], cmdInput: cmd };
  hooks.onMode = m => hooks.modes.push(m);
  hooks.onSave = () => hooks.saved++;
  hooks.onClose = f => hooks.closed.push(f);
  hooks.message = m => hooks.msgs.push(m);
  const api = attachVim(t, hooks);
  return { t, cmd, hooks, api };
}

/* ── 用例 ─────────────────────────────── */
console.log('== 模式与吞键 ==');
{
  const { t, hooks } = setup('host a\nhost b\n');
  eq(hooks.modes[0], 'normal', '挂载即回调 NORMAL');
  const e = t.dispatch('z');
  eq([t.value, e._pd], ['host a\nhost b\n', true], '未映射字母被吞,不落文本');
  eq(t.selectionStart, 0, '未映射字母不移动光标');
  t.dispatch('A'); /* 行尾进入插入 */
  document.execCommand('insertText', false, 'X'); // 模拟原生打字
  eq(t.value, 'host aX\nhost b\n', 'INSERT 态打字生效');
  eq(hooks.modes.at(-1), 'insert', 'A 进入 INSERT');
  t.dispatch('Escape');
  eq(hooks.modes.at(-1), 'normal', 'Esc 回 NORMAL');
  eq(t.selectionStart, t.selectionEnd, 'NORMAL 态选区收拢');
  t.dispatch('d', { isComposing: true });
  t.dispatch('d');
  eq(t.value, 'host aX\nhost b\n', 'IME 组合期按键被忽略');
}
{
  const { t } = setup('ab\n');
  t.dispatch('Backspace');
  eq(t.value, 'ab\n', 'NORMAL 态 Backspace 被吞');
}

console.log('== 移动 ==');
{
  const { t } = setup('abcd\nxy\n12345678\n');
  t.dispatch('l'); t.dispatch('l');
  eq(t.selectionStart, 2, 'l 右移两列');
  t.dispatch('j');
  eq(t.selectionStart, 7, 'j 到短行(列钳制到行尾)');
  t.dispatch('k');
  eq(t.selectionStart, 2, 'k 回来保留列记忆');
  t.dispatch('j'); t.dispatch('j');
  eq(t.selectionStart, 10, 'j 跨过短行后回到记忆列');
  t.dispatch('G');
  eq(t.selectionStart, 8, 'G 到最后一个真实行(忽略尾部换行的虚拟空行)');
  t.dispatch('g'); t.dispatch('g');
  eq(t.selectionStart, 0, 'gg 到文档头');
  t.dispatch('$');
  eq(t.selectionStart, 3, '$ 到行尾字符');
  t.dispatch('0');
  eq(t.selectionStart, 0, '0 到行首');
  t.dispatch('w');
  eq(t.selectionStart, 5, 'w 到下一单词头');
  t.dispatch('b');
  eq(t.selectionStart, 0, 'b 回上一单词头');
  t.dispatch('e');
  eq(t.selectionStart, 3, 'e 到单词尾');
}

console.log('== 行编辑 ==');
{
  const { t, hooks } = setup('line1\nline2\nline3\n');
  t.dispatch('d'); t.dispatch('d');
  eq([t.value, t.selectionStart], ['line2\nline3\n', 0], 'dd 删当前行');
  t.dispatch('p');
  eq(t.value, 'line2\nline1\nline3\n', 'p 粘到当前行下方');
  t.dispatch('P');
  /* p 后光标停在粘贴出的行上,P 往该行上方再粘一行(vim 语义) */
  eq(t.value, 'line2\nline1\nline1\nline3\n', 'P 粘到当前行上方');
  t.dispatch('u');
  eq(t.value, 'line2\nline1\nline3\n', 'u 撤销经原生 undo 栈');
  eq(hooks.msgs.length, 0, '常规行编辑无打扰提示');
}
{
  const { t } = setup('last\n');
  t.dispatch('d'); t.dispatch('d');
  eq([t.value, t.selectionStart], ['', 0], 'dd 最后一行(吞前导换行)至空文档');
  t.dispatch('p');
  eq(t.value, 'last', '空文档 p 不引入前导换行');
}
{
  const { t } = setup('aaa\nbbb\nccc\n');
  t.setSelectionRange(4, 4); // 第二行行首
  t.dispatch('y'); t.dispatch('y');
  t.dispatch('p');
  eq(t.value, 'aaa\nbbb\nbbb\nccc\n', 'yy + p 复制行');
}
{
  const { t } = setup('foo bar\nbaz\n');
  t.dispatch('d'); t.dispatch('w');
  eq(t.value, 'bar\nbaz\n', 'dw 删到下一词头(vim 语义,带走尾随空格)');
}
{
  const { t } = setup('hello\n');
  t.dispatch('x');
  eq([t.value, t.selectionStart], ['ello\n', 0], 'x 删光标下字符');
}
{
  const { t } = setup('a\nb\n');
  t.setSelectionRange(0, 0);
  t.dispatch('o');
  eq(t.selectionStart, 2, 'o 在下方开行并进入插入位');
  document.execCommand('insertText', false, 'mid');
  t.dispatch('Escape');
  eq(t.value, 'a\nmid\nb\n', 'o 的插入落到新行');
  t.setSelectionRange(0, 0);
  t.dispatch('O');
  eq([t.value.slice(0, 2), t.selectionStart], ['\na', 0], 'O 在上方开行');
  t.dispatch('Escape');
}

console.log('== 行首行尾进入插入 ==');
{
  const { t, hooks } = setup('  host a\nhost b\n');
  t.dispatch('^');
  eq(t.selectionStart, 2, '^ 到首个非空白');
  t.dispatch('I');
  eq(hooks.modes.at(-1), 'insert', 'I 行首非空白进入插入');
  t.dispatch('Escape');
  t.dispatch('A');
  eq([t.selectionStart, hooks.modes.at(-1)], [8, 'insert'], 'A 到行尾进入插入');
  t.dispatch('Escape');
  t.setSelectionRange(3, 3);
  t.dispatch('a');
  eq(t.selectionStart, 4, 'a 光标右移一格');
  t.dispatch('Escape');
  eq(hooks.modes.at(-1), 'normal', 'Esc 收尾回 NORMAL');
}

console.log('== : 命令行 ==');
{
  const { t, cmd, hooks, api } = setup('x\n');
  t.dispatch(':');
  eq(cmd.parentElement.classList.contains('hidden'), false, ': 唤起命令输入');
  eq(cmd.focused, 1, '命令输入自动聚焦');
  cmd.value = 'w';
  cmd.dispatch('Enter');
  eq(hooks.saved, 1, ':w 触发保存');
  cmd.value = 'q';
  cmd.dispatch('Enter');
  eq(hooks.closed, [false], ':q 关闭(可拦截)');
  cmd.value = 'q!';
  cmd.dispatch('Enter');
  eq(hooks.closed.at(-1), true, ':q! 强制关闭');
  cmd.value = 'wq';
  cmd.dispatch('Enter');
  eq([hooks.saved, hooks.closed.at(-1)], [2, true], ':wq 保存并关闭');
  cmd.value = 'foobar';
  cmd.dispatch('Enter');
  eq(hooks.msgs.length > 0, true, '未知命令有提示');
  eq(api.command('w'), undefined, 'api.command 直通可用');
  eq(api.mode(), 'normal', 'mode() 查询');
}

console.log('== detach ==');
{
  const { t, api } = setup('ab\n');
  api.detach();
  const e = t.dispatch('x');
  eq(e._pd, false, 'detach 后不再拦截键');
}

console.log('─────');
console.log(fail === 0 ? `vim 层测试全部通过(${pass} 项)` : `${fail} 项失败 / ${pass} 项通过`);
process.exit(fail === 0 ? 0 : 1);