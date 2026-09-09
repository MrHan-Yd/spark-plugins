/* Hosts切换 编辑抽屉模块:方案/公共配置编辑器 + 备份查看 + vim 挂载 + 备份导出。
 * 依赖 page.js 顶层的 $, S, rpc, toast, refresh, confirmModal, openDrawer/closeDrawer 等共享符号;
 * 经 <script src="editor.js"> 在 page.js 之后加载(其内部函数在运行期才被调用)。 */
/* ── 编辑抽屉(方案 / 公共配置共用) ────── */
const VIM_KEY = 'spark_hostsswitch_vim';
function vimOn() { try { return localStorage.getItem(VIM_KEY) === '1'; } catch (e) { return false; } }
function setVimOn(v) { try { localStorage.setItem(VIM_KEY, v ? '1' : '0'); } catch (e) {} }

function syncVimAttach() {
  const ed = S.editor;
  if (!ed) return;
  if (ed.vim) { ed.vim.detach(); ed.vim = null; }
  const badge = $('#vimMode');
  if (vimOn()) {
    ed.vim = attachVim($('#edText'), {
      onMode(m) {
        badge.classList.remove('hidden');
        badge.textContent = m === 'insert' ? 'INSERT' : 'NORMAL';
        badge.classList.toggle('insert', m === 'insert');
      },
      onSave: () => saveEditor(),
      onClose: force => closeEditor(force),
      message: msg => toast(msg),
      cmdInput: $('#vimCmd'),
    });
  } else {
    badge.classList.add('hidden');
  }
}

function isDirty() {
  const ed = S.editor;
  if (!ed || ed.kind === 'bk') return false; /* 备份查看只读,无脏状态 */
  return $('#edName').value !== ed.initial.name || $('#edText').value !== ed.initial.content;
}

function openEditor(kind, scheme) {
  if (kind === 'bk') return openBkViewer(scheme);
  if (S.editor && S.editor.vim) S.editor.vim.detach();
  const ed = kind === 'base'
    ? { kind, id: null, name: '', content: S.st.base }
    : scheme
      ? { kind: 'scheme', id: scheme.id, name: scheme.name, content: scheme.content }
      : { kind: 'scheme', id: null, name: '', content: '# 新建方案:每行一条「IP 域名」\n# 127.0.0.1 example.com\n10.0.0.1 api.example.com\n' };
  ed.initial = { name: ed.name, content: ed.content };
  S.editor = ed;
  $('#edTitle').textContent = kind === 'base' ? '公共配置(合并的基础内容)' : scheme ? '编辑方案' : '新建方案';
  $('#edNameRow').classList.toggle('hidden', kind === 'base');
  $('#edImportRow').classList.toggle('hidden', kind !== 'base');
  $('#edHint').textContent = kind === 'base'
    ? '公共配置是每次合并的底稿,系统 hosts 初始内容已存于此'
    : '每行一条,格式:IP 域名;以 # 开头的行为注释';
  $('#edName').value = ed.name;
  const ta = $('#edText');
  ta.value = ed.content;
  ta.readOnly = false;
  $('#vimWrap').classList.remove('hidden');
  $('#vimMode').classList.remove('hidden');
  $('#btnBkRestore').classList.add('hidden');
  $('#btnBkToScheme').classList.add('hidden');
  $('#btnEdSave').classList.remove('hidden');
  $('#btnEdCancel').textContent = '取消';
  $('#vimToggle').checked = vimOn();
  syncVimAttach();
  updateGutter();
  updatePos();
  openDrawer('#edDrawer');
  (kind === 'base' ? ta : $('#edName')).focus();
}

/* 备份查看抽屉:只读,可转方案 / 恢复为公共配置 */
function openBkViewer(bk) {
  if (S.editor && S.editor.vim) S.editor.vim.detach();
  const ed = { kind: 'bk', id: bk.id, name: bk.name, content: bk.content };
  ed.initial = { name: '', content: bk.content };
  S.editor = ed;
  $('#edTitle').textContent = '备份内容 · ' + bk.name;
  $('#edNameRow').classList.add('hidden');
  $('#edImportRow').classList.add('hidden');
  $('#edHint').textContent = '备份只读 · 可转为方案或恢复为公共配置';
  const ta = $('#edText');
  ta.value = bk.content;
  ta.readOnly = true;
  $('#vimWrap').classList.add('hidden');
  $('#vimMode').classList.add('hidden');
  $('#btnBkRestore').classList.remove('hidden');
  $('#btnBkToScheme').classList.remove('hidden');
  $('#btnEdSave').classList.add('hidden');
  $('#btnEdCancel').textContent = '关闭';
  updateGutter();
  updatePos();
  openDrawer('#edDrawer');
  ta.focus();
}

async function deleteBackup(bk) {
  confirmModal('删除备份', `确定删除备份「${bk.name}」?备份文件将一并删除,不可恢复。`, async () => {
    try {
      await rpc('delete_backup', { id: bk.id });
      await refresh();
      toast('已删除备份');
    } catch (e) { toast(String(e.message || e), true); }
  }, true);
}

$('#btnBkRestore').addEventListener('click', () => {
  const ed = S.editor;
  if (!ed || ed.kind !== 'bk') return;
  confirmModal('恢复公共配置', '用该备份内容覆盖公共配置?覆盖后需「应用」才会写入系统 hosts。', async () => {
    try {
      await rpc('set_base', { content: $('#edText').value });
      await refresh();
      closeEditor(true);
      toast('已恢复为公共配置(应用后写入 hosts)');
    } catch (e) { toast(String(e.message || e), true); }
  });
});
$('#btnBkToScheme').addEventListener('click', async () => {
  const ed = S.editor;
  if (!ed || ed.kind !== 'bk') return;
  try {
    const s = await rpc('create_scheme', { name: '备份 ' + ed.name, content: $('#edText').value });
    S.sel.add(s.id);
    await rpc('set_active', { ids: [...S.sel] });
    await refresh();
    closeEditor(true);
    toast('已转为方案并勾选(应用后写入 hosts)');
  } catch (e) { toast(String(e.message || e), true); }
});

function closeEditor(force) {
  const ed = S.editor;
  if (!ed) return;
  if (!force && isDirty()) {
    confirmModal('放弃修改?', '编辑内容尚未保存,关闭将丢失。', () => closeEditor(true));
    return;
  }
  if (ed.vim) ed.vim.detach();
  S.editor = null;
  closeDrawer('#edDrawer');
}

/* 保存成功返回 true,失败/被拦截返回 false(vim 的 :wq/:x 依据它决定是否关抽屉) */
let savingEd = false;
async function saveEditor() {
  if (savingEd) return false; /* 保存进行中,忽略重复触发(:wq 连按 / 双击保存) */
  const ed = S.editor;
  if (!ed || ed.kind === 'bk') return false; /* 备份只读查看:不允许经此覆盖公共配置 */
  const name = $('#edName').value.trim();
  const content = $('#edText').value;
  savingEd = true;
  try {
    if (ed.kind === 'scheme') {
      if (!name) { toast('方案名不能为空', true); $('#edName').focus(); return false; }
      if (ed.id) {
        await rpc('update_scheme', { id: ed.id, name, content });
      } else {
        const s = await rpc('create_scheme', { name, content });
        S.sel.add(s.id);
        await rpc('set_active', { ids: [...S.sel] });
      }
      await refresh();
      closeEditor(true);
      toast(ed.id ? '方案已保存(应用后写入 hosts)' : '方案已创建并勾选(应用后写入 hosts)');
    } else {
      await rpc('set_base', { content });
      await refresh();
      closeEditor(true);
      toast('公共配置已保存(应用后写入 hosts)');
    }
    return true;
  } catch (e) {
    toast(String(e.message || e), true);
    return false;
  } finally {
    savingEd = false;
  }
}

/* 行号 / 光标位置 */
function updateGutter() {
  const ta = $('#edText');
  const n = ta.value.split('\n').length;
  let s = '';
  for (let i = 1; i <= n; i++) s += i + '\n';
  $('#edGutter').textContent = s;
  $('#edGutter').scrollTop = ta.scrollTop;
}
function updatePos() {
  const ta = $('#edText');
  const p = ta.selectionStart;
  const before = ta.value.slice(0, p);
  const ln = before.split('\n').length;
  const col = p - (before.lastIndexOf('\n') + 1) + 1;
  $('#vimPos').textContent = `${ln}:${col}`;
}
$('#edText').addEventListener('input', () => { updateGutter(); updatePos(); });
$('#edText').addEventListener('scroll', () => { $('#edGutter').scrollTop = $('#edText').scrollTop; });
document.addEventListener('selectionchange', () => {
  if (S.editor && document.activeElement === $('#edText')) updatePos();
});
$('#edText').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveEditor();
  }
});
$('#vimToggle').addEventListener('change', () => {
  setVimOn($('#vimToggle').checked);
  syncVimAttach();
  $('#edText').focus();
});
$('#btnEdSave').addEventListener('click', saveEditor);
$('#btnEdCancel').addEventListener('click', () => closeEditor(false));
$('#btnEdClose').addEventListener('click', () => closeEditor(false));

/* 公共配置:从当前系统 hosts 重新导入 */
$('#btnImportCur').addEventListener('click', () => {
  if (!S.st || !S.st.readable) { toast('无法读取当前系统 hosts', true); return; }
  confirmModal('导入系统 hosts', '用当前系统 hosts 的内容覆盖公共配置?合并时以公共配置为准,建议先把差异并入方案。', async () => {
    try {
      await rpc('set_base', { content: S.st.current });
      await refresh();
      openEditor('base');
      toast('已导入当前系统 hosts 内容');
    } catch (e) { toast(String(e.message || e), true); }
  });
});

/* 公共配置:一键备份导出(exe 落盘默认桌面并定位;失败时退系统「另存为」) */
function backupStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
async function exportBase() {
  if (!S.st) return;
  const inEditor = S.editor && S.editor.kind === 'base';
  const content = inEditor ? $('#edText').value : S.st.base;
  let rpcErr = null;
  try {
    await rpc('export_base', inEditor ? { content } : {});
    await refresh();
    toast('公共配置已备份,已在列表显示备份条目');
    return;
  } catch (e) { rpcErr = e; /* 落盘失败 → 系统「另存为」兜底 */ }
  if (window.showSaveFilePicker) {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: `hosts-公共配置-${backupStamp()}.txt`,
        types: [{ description: '文本文件', accept: { 'text/plain': ['.txt'] } }],
      });
      const w = await handle.createWritable();
      await w.write(new Blob([content], { type: 'text/plain' }));
      await w.close();
      toast('公共配置已备份');
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) toast('已取消备份');
      else toast(String(e.message || e), true);
    }
  } else {
    toast(String((rpcErr && rpcErr.message) || rpcErr), true);
  }
}
$('#btnBackupBase').addEventListener('click', exportBase);
