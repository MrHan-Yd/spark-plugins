'use strict';
/* 进程终结者 页面逻辑:聚合搜索(端口/PID/名称)+ 温和结束/强杀 + 复制路径/定位。
 * 原生能力(进程枚举、结束进程)全部经 spark.rpc 走 exe,页面即 UI。 */

const $ = s => document.querySelector(s);

/* ── 主题(家族惯例:localStorage 持久化,默认暗色) ── */
const THEME_KEY = 'spark_processkiller_theme';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
}
applyTheme((() => { try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { return 'dark'; } })());
$('#btnTheme').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

/* ── toast ────────────────────────────── */
let toastTimer = 0;
function toast(msg, cls) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('err', 'ok');
  if (cls) el.classList.add(cls);
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2800);
}

/* ── 宿主 RPC(native 页面专属;exe 经 host 懒启动) ── */
function hasHost() { return !!(window.spark && typeof spark.rpc === 'function'); }
async function rpc(method, args) {
  if (!hasHost()) throw new Error('未检测到 Spark 宿主,请在 Spark 插件窗口中打开本页面');
  return await spark.rpc(method, args);
}

/* ── 状态 ─────────────────────────────── */
const S = {
  q: '',            // 当前生效查询
  rows: [],         // 最近一次搜索结果
  meta: null,       // { total, procs_total, took_ms, self_pid }
  seq: 0,           // 搜索序号(丢弃过期响应)
  busy: false,      // 结束动作进行中
  pending: null,    // 弹窗待执行动作 { pid, name, mode, followup }
};

/* ── 搜索 ─────────────────────────────── */
let debounce = 0;
const input = $('#q');

function doSearch(q) {
  const text = q === undefined ? input.value.trim() : String(q).trim();
  const seq = ++S.seq;
  setStatus('busy', '搜索中…');
  $('#stMeta').textContent = '';
  return rpc('search', { q: text })
    .then(r => {
      if (seq !== S.seq) return; // 已有更新的搜索
      S.q = text;
      S.rows = r.rows || [];
      S.meta = r;
      setStatus(r.rows && r.rows.length ? 'on' : 'on', '就绪');
      render(r);
    })
    .catch(e => {
      if (seq !== S.seq) return;
      setStatus('err', e && e.message ? e.message : '搜索失败');
    });
}

function onInputChanged() {
  const v = input.value;
  $('#btnClear').classList.toggle('hidden', !v);
  clearTimeout(debounce);
  const t = v.trim();
  if (!t) { S.seq++; S.q = ''; S.rows = []; renderGuide(); setStatus('on', '就绪'); $('#stMeta').textContent = ''; return; }
  debounce = setTimeout(() => doSearch(t), 150);
}

input.addEventListener('input', onInputChanged);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(debounce); doSearch(); }
  if (e.key === 'Escape') { input.value = ''; onInputChanged(); input.focus(); }
});
$('#btnClear').addEventListener('click', () => { input.value = ''; onInputChanged(); input.focus(); });
$('#btnGo').addEventListener('click', () => { clearTimeout(debounce); doSearch(); });
$('#btnRefresh').addEventListener('click', () => { clearTimeout(debounce); doSearch(S.q || undefined); });

function setStatus(cls, text) {
  $('#stDot').className = 'dot' + (cls ? ' ' + cls : '');
  $('#stText').textContent = text;
}

/* ── 渲染 ─────────────────────────────── */
function fmtMem(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function fmtStartTime(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const md = String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const day0 = t => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  return day0(Date.now()) === day0(sec * 1000) ? '今日 ' + hm : md + ' ' + hm;
}

function tagClass(t) {
  if (t === 'PID 精确' || t === 'PID') return 'pid';
  if (t.startsWith('端口')) return 'port';
  if (t === '名称精确') return 'exact';
  if (t === '路径命中') return 'path';
  return 'more';
}

const SVG_GRACE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5.5v13M5.5 12h13" transform="rotate(45 12 12)" opacity=".9"/><circle cx="12" cy="12" r="9.2"/></svg>';
const SVG_FORCE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.6"/><path d="M6.8 6.8l10.4 10.4M17.2 6.8L6.8 17.2"/></svg>';
const SVG_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8.5" y="8.5" width="11" height="11" rx="1.8"/><path d="M15.5 5.5h-10a1 1 0 0 0-1 1v10"/></svg>';
const SVG_DIR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.2l2 2.5H19A1.5 1.5 0 0 1 20.5 9v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z"/></svg>';

function render(r) {
  const list = $('#list');
  list.innerHTML = '';
  if (!r.rows || !r.rows.length) { renderNoHit(r); return; }
  for (const row of r.rows) list.appendChild(buildRow(row));
  $('#stMeta').textContent =
    '命中 ' + r.total + (r.total > r.rows.length ? '(显示前 ' + r.rows.length + ')' : '') +
    ' / 全系统 ' + r.procs_total + ' 进程 · ' + r.took_ms + ' ms';
}

function buildRow(row) {
  const el = document.createElement('div');
  el.className = 'row' + (S.meta && row.pid === S.meta.self_pid ? ' me' : '');

  const rp = document.createElement('div');
  rp.className = 'rp mono';
  rp.textContent = row.pid;
  rp.title = row.pid === (S.meta && S.meta.self_pid) ? '插件自身进程' : '';
  el.appendChild(rp);

  const main = document.createElement('div');
  main.className = 'rmain';

  const nameLine = document.createElement('div');
  nameLine.className = 'rname';
  const nb = document.createElement('b');
  nb.textContent = row.name || '(未知)';
  nameLine.appendChild(nb);
  for (const t of row.tags || []) {
    const s = document.createElement('span');
    s.className = 'tag ' + tagClass(t);
    s.textContent = t;
    nameLine.appendChild(s);
  }
  main.appendChild(nameLine);

  const ports = row.ports || [];
  if (ports.length) {
    const pw = document.createElement('div');
    pw.className = 'rports';
    for (const p of ports) {
      const c = document.createElement('span');
      c.className = 'pchip' + (p.proto === 'udp' ? ' udp' : '');
      const b = document.createElement('b'); b.className = 'mono'; b.textContent = ':' + p.port;
      const i = document.createElement('i');
      i.textContent = p.proto.toUpperCase() + (p.state ? '·' + p.state : '');
      c.appendChild(b); c.appendChild(i);
      c.title = p.addr;
      pw.appendChild(c);
    }
    if (row.ports_more > 0) {
      const more = document.createElement('span');
      more.className = 'tag more';
      more.textContent = '+' + row.ports_more + ' 端口';
      pw.appendChild(more);
    }
    main.appendChild(pw);
  }

  if (row.exe) {
    const p = document.createElement('div');
    p.className = 'rpath mono';
    p.textContent = row.exe;
    p.title = (row.cmd ? '命令行:' + row.cmd : row.exe) +
      (row.start_time ? '\n启动:' + fmtStartTime(row.start_time) : '');
    main.appendChild(p);
  }
  el.appendChild(main);

  const mem = document.createElement('div');
  mem.className = 'rmem mono';
  mem.textContent = fmtMem(row.mem);
  mem.title = '物理内存占用';
  el.appendChild(mem);

  const act = document.createElement('div');
  act.className = 'ract';
  act.appendChild(killBtn('grace', '温和', SVG_GRACE, row));
  act.appendChild(killBtn('force', '强杀', SVG_FORCE, row));
  const copy = iconBtn(SVG_COPY, '复制 exe 路径');
  copy.addEventListener('click', () => copyPath(row));
  act.appendChild(copy);
  const loc = iconBtn(SVG_DIR, '打开文件位置');
  loc.addEventListener('click', () => locate(row));
  act.appendChild(loc);
  el.appendChild(act);
  return el;
}

function killBtn(cls, label, svg, row) {
  const b = document.createElement('button');
  b.className = 'kb ' + cls;
  b.innerHTML = svg + '<span>' + label + '</span>';
  b.addEventListener('click', () => killFlow(row, cls === 'force' ? 'force' : 'graceful'));
  return b;
}
function iconBtn(svg, title) {
  const b = document.createElement('button');
  b.className = 'kb ic';
  b.innerHTML = svg;
  b.title = title;
  return b;
}

/* ── 空态:引导 + 可点示例 ──────────────── */
const EXAMPLES = [
  [':8080', '端口'],
  ['pid 1234', 'PID'],
  ['chrome', '进程名'],
  ['svchost -k', '名称+参数'],
];
const GICON = '<svg class="gicon" viewBox="0 0 128 128"><rect x="6" y="6" width="116" height="116" rx="30" fill="var(--panel3)" opacity=".35"/><circle cx="64" cy="64" r="25" fill="none" stroke="var(--danger)" stroke-width="7.5" opacity=".85"/><path d="M64 13v17M64 98v17M13 64h17M98 64h17" stroke="var(--danger)" stroke-width="7.5" stroke-linecap="round" opacity=".85"/><circle cx="64" cy="64" r="7" fill="var(--danger)"/></svg>';

function renderGuide() {
  const list = $('#list');
  list.innerHTML = '';
  const g = document.createElement('div');
  g.className = 'guide';
  g.innerHTML = GICON;
  const h = document.createElement('h3');
  h.textContent = '一个框,找到并结束任何进程';
  g.appendChild(h);
  const p = document.createElement('p');
  p.textContent = '输入端口号、PID、进程名或路径关键词;条件用空格分隔(且关系)';
  g.appendChild(p);
  const ex = document.createElement('div');
  ex.className = 'gex';
  for (const [code, note] of EXAMPLES) {
    const c = document.createElement('code');
    c.className = 'mono';
    c.textContent = code;
    const i = document.createElement('i');
    i.textContent = note;
    c.appendChild(i);
    c.addEventListener('click', () => { input.value = code; onInputChanged(); input.focus(); });
    ex.appendChild(c);
  }
  g.appendChild(ex);
  const tip = document.createElement('div');
  tip.className = 'gtip';
  tip.innerHTML = '<b>:8080</b> 端口占用 · <b>pid:123</b> 指定 PID · 纯数字 = PID 或端口双查<br>「温和」向 GUI 程序发关闭请求,「强杀」立即终止';
  g.appendChild(tip);
  list.appendChild(g);
  $('#stMeta').textContent = '';
}

function renderNoHit(r) {
  const list = $('#list');
  list.innerHTML = '';
  const g = document.createElement('div');
  g.className = 'guide';
  g.appendChild(GICON ? document.createRange().createContextualFragment(GICON) : document.createElement('div'));
  const h = document.createElement('h3');
  h.textContent = '没有匹配的进程';
  g.appendChild(h);
  const p = document.createElement('p');
  p.textContent = '换个关键词试试:端口(:8080)、PID(pid:123)、进程名或路径';
  g.appendChild(p);
  list.appendChild(g);
  $('#stMeta').textContent = '命中 0 / 全系统 ' + (r.procs_total || 0) + ' 进程 · ' + (r.took_ms || 0) + ' ms';
}

/* ── 弹窗 ─────────────────────────────── */
function ask(opts) {
  return new Promise(resolve => {
    S.pending = { resolve };
    $('#mdTitle').textContent = opts.title;
    const body = $('#mdBody');
    body.innerHTML = '';
    const name = document.createElement('span');
    name.style.cssText = 'color:var(--text);font-weight:600;font-size:13.5px';
    name.textContent = opts.name;
    body.appendChild(name);
    body.appendChild(document.createTextNode(opts.body || ''));
    $('#mdWarn').classList.toggle('hidden', !opts.warn);
    $('#btnMdOk').textContent = opts.okText || '确定';
    $('#modal').classList.add('on');
    $('#btnMdCancel').focus();
  });
}
function closeModal(v) {
  $('#modal').classList.remove('on');
  const p = S.pending;
  S.pending = null;
  if (p) p.resolve(v);
}
$('#btnMdCancel').addEventListener('click', () => closeModal(false));
$('#btnMdOk').addEventListener('click', () => closeModal(true));
$('#modal').addEventListener('mousedown', e => { if (e.target === $('#modal')) closeModal(false); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#modal').classList.contains('on')) closeModal(false);
});

/* ── 结束进程流程 ──────────────────────── */
async function killFlow(row, mode) {
  if (S.busy) return;
  const force = mode === 'force';
  const ok = await ask({
    name: (row.name || '(未知)') + ' · PID ' + row.pid,
    body: force
      ? '\n\n将被立即终止,未保存的数据会丢失。' + (row.exe ? '\n' : '') + (row.exe || '')
      : '\n\n将发送关闭请求(GUI 程序可自行保存退出);无窗口程序可能不响应。',
    warn: false,
    okText: force ? '立即强杀' : '发送关闭请求',
  });
  if (!ok) return;
  await runKill(row, mode);
}

async function runKill(row, mode) {
  S.busy = true;
  setRowsDisabled(true);
  setStatus('busy', mode === 'force' ? '正在强杀…' : '正在发送关闭请求…');
  try {
    const r = await rpc('kill', { pid: row.pid, mode });
    if (r.exited) {
      toast('已结束 ' + (row.name || 'PID ' + row.pid), 'ok');
    } else if (mode === 'graceful') {
      const again = await ask({
        name: (row.name || 'PID ' + row.pid),
        body: '\n\n' + (r.detail || '进程未退出'),
        warn: true,
        okText: '改用强杀',
      });
      if (again) {
        setStatus('busy', '正在强杀…');
        const r2 = await rpc('kill', { pid: row.pid, mode: 'force' });
        toast(r2.exited ? '已强杀 ' + (row.name || 'PID ' + row.pid) : (r2.detail || '进程未退出'), r2.exited ? 'ok' : 'err');
      }
    } else {
      toast(r.detail || '进程未退出', 'err');
    }
  } catch (e) {
    toast((e && e.message) || '操作失败', 'err');
  }
  S.busy = false;
  setRowsDisabled(false);
  setStatus('on', '就绪');
  if (S.q) doSearch(S.q); // 刷新列表(进程状态已变化)
}

function setRowsDisabled(dis) {
  for (const b of document.querySelectorAll('.kb:not(.ic)')) b.disabled = dis;
}

async function copyPath(row) {
  if (!row.exe) { toast('该进程未提供可执行路径', 'err'); return; }
  try {
    if (window.spark && spark.clipboard && spark.clipboard.writeText) {
      await spark.clipboard.writeText(row.exe);
      toast('已复制路径', 'ok');
    } else {
      toast('剪贴板不可用(需 Spark 宿主)', 'err');
    }
  } catch (e) {
    toast((e && e.message) || '复制失败', 'err');
  }
}

async function locate(row) {
  try {
    await rpc('locate', { pid: row.pid });
    toast('已在资源管理器定位', 'ok');
  } catch (e) {
    toast((e && e.message) || '定位失败', 'err');
  }
}

/* ── 页面加固:屏蔽默认右键菜单与浏览器快捷键 ── */
document.addEventListener('contextmenu', e => {
  // 输入框/文本域保留系统菜单(剪切/复制/粘贴)
  if (e.target && e.target.closest && e.target.closest('input, textarea')) return;
  e.preventDefault();
});
document.addEventListener('keydown', e => {
  const k = (e.key || '').toLowerCase();
  const editing = e.target && e.target.closest && e.target.closest('input, textarea');
  // DevTools / 打印 / 刷新:任何焦点都拦(F12、F5、Ctrl+Shift+I/J/C、Ctrl+P)
  if (k === 'f12' || k === 'f5' ||
      (e.shiftKey && (e.ctrlKey || e.metaKey) && (k === 'i' || k === 'j' || k === 'c')) ||
      ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'p')) {
    e.preventDefault();
    return;
  }
  // Ctrl+R:输入框/文本域内放行;其余位置(会整页刷新)拦截
  if (!editing && (e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'r') {
    e.preventDefault();
  }
}, true);

/* ── 启动:宿主带回的输入直接开搜(kill 8080 → 打开即搜) ── */
(async function init() {
  renderGuide();
  if (!hasHost()) {
    setStatus('err', '未检测到 Spark 宿主(开发预览)');
    return;
  }
  setStatus('busy', '连接插件中…');
  try {
    const t = spark.input && typeof spark.input.text === 'string' ? spark.input.text.trim() : '';
    if (t) {
      input.value = t;
      $('#btnClear').classList.remove('hidden');
      await doSearch(t);
    } else {
      setStatus('on', '就绪');
    }
  } catch (e) {
    setStatus('err', (e && e.message) || '初始化失败');
  }
  input.focus();
})();