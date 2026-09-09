'use strict';
/* Hosts切换 页面逻辑:方案列表 / 勾选合并应用 / 右键管理 / 编辑器(vim 可选) / 预览 / 帮助。
 * 原生能力(读写 hosts、配置持久化、DNS 刷新)全部经 spark.rpc 走 exe,页面即 UI。 */

const $ = s => document.querySelector(s);

/* ── 主题(家族惯例:localStorage 持久化,默认暗色) ── */
const THEME_KEY = 'spark_hostsswitch_theme';
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
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2600);
}

/* ── 宿主 RPC(native 页面专属;exe 经 host 懒启动) ── */
function hasHost() { return !!(window.spark && typeof spark.rpc === 'function'); }
async function rpc(method, args) {
  if (!hasHost()) throw new Error('未检测到 Spark 宿主,请在 Spark 插件窗口中打开本页面');
  return await spark.rpc(method, args);
}

/* ── 状态 ─────────────────────────────── */
const S = {
  st: null,        // exe get_state 结果
  sel: new Set(),  // 页面当前勾选(方案 id)
  editor: null,    // { kind:'scheme'|'base', id, initial:{name,content}, vim }
  ctxFor: null,    // 右键菜单针对的方案 id
};

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

async function refresh() {
  const st = await rpc('get_state', {});
  S.st = st;
  S.sel = new Set(st.active_ids || []);
  renderAll();
}

function renderAll() {
  renderList();
  renderStatus();
  renderApplyBtn();
}

/* ── 文案工具 ─────────────────────────── */
function relTime(ms) {
  if (!ms) return '—';
  const d = Date.now() - ms;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  /* 「昨天」按日历日判定:固定 48h 窗口会把前天凌晨的时间也标成昨天 */
  const dt = new Date(ms);
  const day0 = t => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const days = Math.round((day0(Date.now()) - day0(ms)) / 86400000);
  if (days === 1) return '昨天 ' + dt.toTimeString().slice(0, 5);
  const md = String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  return dt.getFullYear() === new Date().getFullYear() ? md : dt.getFullYear() + '-' + md;
}
function lineCount(c) {
  const s = String(c || '');
  return s ? s.replace(/\r?\n$/, '').split(/\r?\n/).length : 0;
}
function snippet(c) {
  const lines = String(c || '').split(/\r?\n/);
  for (const l of lines) {
    const t = l.trim();
    if (t && !t.startsWith('#')) return t;
  }
  return '(仅注释)';
}

const SVG_MORE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="5.5" r="0.8"/><circle cx="12" cy="12" r="0.8"/><circle cx="12" cy="18.5" r="0.8"/></svg>';
const SVG_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5.5v13M5.5 12h13"/></svg>';
const SVG_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h7L18.5 8v11a1.8 1.8 0 0 1-1.8 1.8H7A1.8 1.8 0 0 1 5.2 19V5.3A1.8 1.8 0 0 1 7 3.5z"/><path d="M13.5 3.8V8h4.5"/><path d="M9 14.5h6M12 11.5v6"/></svg>';

/* ── 列表渲染 ─────────────────────────── */
function renderList() {
  const list = $('#list');
  list.innerHTML = '';
  if (!S.st) return;

  /* 公共配置卡:始终合并,不可取消;整卡可点进编辑器 */
  const base = document.createElement('div');
  base.className = 'card base';
  const bck = document.createElement('input');
  bck.type = 'checkbox'; bck.className = 'ck'; bck.checked = true; bck.disabled = true;
  bck.title = '公共配置始终参与合并';
  const bmain = document.createElement('div'); bmain.className = 'cmain';
  const bname = document.createElement('div'); bname.className = 'cname';
  const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = '公共配置';
  bname.appendChild(badge);
  if (!S.st.base_seeded) {
    const warn = document.createElement('span');
    warn.className = 'badge warn';
    warn.textContent = '首次未读到系统 hosts,请粘贴原内容';
    bname.appendChild(warn);
  }
  const bsnip = document.createElement('div'); bsnip.className = 'csnip';
  bsnip.textContent = snippet(S.st.base);
  bmain.appendChild(bname); bmain.appendChild(bsnip);
  const bmeta = document.createElement('div'); bmeta.className = 'cmeta';
  const blines = document.createElement('span'); blines.className = 'lines';
  blines.textContent = lineCount(S.st.base) + ' 行';
  bmeta.appendChild(blines);
  base.appendChild(bck); base.appendChild(bmain); base.appendChild(bmeta);
  base.addEventListener('dblclick', () => openEditor('base'));
  base.addEventListener('click', e => { if (e.target === bck) return; openEditor('base'); });
  list.appendChild(base);

  /* 方案卡(入场动画错峰) */
  const schemes = S.st.schemes || [];
  let cardIdx = 1; /* 公共配置卡 = 第 0 张 */
  for (const sc of schemes) {
    const row = document.createElement('div');
    row.className = 'card' + (S.sel.has(sc.id) ? ' on' : '');
    row.dataset.id = sc.id;
    row.style.animationDelay = Math.min(cardIdx++ * 35, 240) + 'ms';

    const ck = document.createElement('input');
    ck.type = 'checkbox'; ck.className = 'ck'; ck.checked = S.sel.has(sc.id);
    ck.addEventListener('click', e => e.stopPropagation());
    ck.addEventListener('change', () => {
      if (ck.checked) S.sel.add(sc.id); else S.sel.delete(sc.id);
      row.classList.toggle('on', ck.checked);
      persistSel();
    });

    const main = document.createElement('div'); main.className = 'cmain';
    const name = document.createElement('div'); name.className = 'cname';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = sc.name;
    name.appendChild(nm);
    if ((S.st.last_applied_ids || []).includes(sc.id) && (S.st.last_applied_ids || []).length) {
      const live = document.createElement('span');
      live.className = 'badge'; live.textContent = '当前生效';
      name.appendChild(live);
    }
    const snip = document.createElement('div'); snip.className = 'csnip';
    snip.textContent = snippet(sc.content);
    main.appendChild(name); main.appendChild(snip);

    const meta = document.createElement('div'); meta.className = 'cmeta';
    const lines = document.createElement('span'); lines.className = 'lines';
    lines.textContent = lineCount(sc.content) + ' 行 · ' + relTime(sc.updated_ms);

    const acts = document.createElement('div'); acts.className = 'acts';
    const mk = (label, act, primary) => {
      const b = document.createElement('button');
      b.className = 'ab' + (primary ? ' primary' : '');
      b.textContent = label;
      b.addEventListener('click', e => {
        e.stopPropagation();
        if (e.detail > 1) return; /* 双击按钮只算一次操作(防重复写入 hosts) */
        ctxAction(act, sc.id);
      });
      return b;
    };
    acts.appendChild(mk('应用', 'apply', true));
    acts.appendChild(mk('编辑', 'edit'));
    const more = document.createElement('button');
    more.className = 'ab more'; more.title = '更多操作'; more.innerHTML = SVG_MORE;
    more.addEventListener('click', e => {
      e.stopPropagation();
      if (e.detail > 1) return;
      openCtx(sc.id, more.getBoundingClientRect());
    });
    acts.appendChild(more);

    meta.appendChild(lines); meta.appendChild(acts);
    row.appendChild(ck); row.appendChild(main); row.appendChild(meta);

    row.addEventListener('dblclick', e => {
      /* 双击 = 确保勾选并立即写入(已勾选则按当前勾选整组写入);
       * 复选框/操作按钮只拦了 click,dblclick 会冒泡上来,必须排除 */
      if (e.target.closest && e.target.closest('.ck, .acts')) return;
      if (!S.sel.has(sc.id)) { S.sel.add(sc.id); persistSel(); }
      applyNow();
    });
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      openCtx(sc.id, { left: e.clientX, top: e.clientY });
    });
    list.appendChild(row);
  }

  /* 备份卡(公共配置的历史快照,只读;点击查看) */
  const backups = S.st.backups || [];
  for (const bk of backups) {
    const row = document.createElement('div');
    row.className = 'card';
    row.dataset.id = bk.id;
    row.style.animationDelay = Math.min(cardIdx++ * 35, 240) + 'ms';

    const main = document.createElement('div'); main.className = 'cmain';
    const name = document.createElement('div'); name.className = 'cname';
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = '备份';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = bk.name;
    name.appendChild(badge); name.appendChild(nm);
    const snip = document.createElement('div'); snip.className = 'csnip';
    snip.textContent = snippet(bk.content);
    main.appendChild(name); main.appendChild(snip);

    const meta = document.createElement('div'); meta.className = 'cmeta';
    const lines = document.createElement('span'); lines.className = 'lines';
    lines.textContent = lineCount(bk.content) + ' 行 · ' + relTime(bk.created_ms);
    const acts = document.createElement('div'); acts.className = 'acts';
    const view = document.createElement('button'); view.className = 'ab'; view.textContent = '查看';
    view.addEventListener('click', e => { e.stopPropagation(); if (e.detail > 1) return; openBkViewer(bk); });
    const del = document.createElement('button'); del.className = 'ab'; del.textContent = '删除';
    del.addEventListener('click', e => { e.stopPropagation(); if (e.detail > 1) return; deleteBackup(bk); });
    acts.appendChild(view); acts.appendChild(del);
    meta.appendChild(lines); meta.appendChild(acts);

    row.appendChild(main); row.appendChild(meta);
    row.addEventListener('click', () => openBkViewer(bk));
    list.appendChild(row);
  }

  /* 空态引导 */
  if (!schemes.length) {
    const box = document.createElement('div');
    box.className = 'state';
    const big = document.createElement('div'); big.className = 'big'; big.innerHTML = SVG_EMPTY;
    const h = document.createElement('h3'); h.textContent = '还没有自定义方案';
    const p = document.createElement('p');
    p.textContent = '把不同环境需要追加的 hosts 条目分别存成方案,勾选后与公共配置合并写入系统 hosts。';
    const steps = document.createElement('div'); steps.className = 'steps';
    [['1', '点「新建方案」,给方案起名并填入 hosts 条目'],
     ['2', '勾选一个或多个方案(可组合)'],
     ['3', '双击方案或点「应用到 hosts」,立即生效']].forEach(([n, t]) => {
      const sp = document.createElement('span');
      const b = document.createElement('b'); b.textContent = n;
      sp.appendChild(b); sp.appendChild(document.createTextNode(t));
      steps.appendChild(sp);
    });
    const btn = document.createElement('button'); btn.className = 'btn primary';
    btn.innerHTML = SVG_PLUS + '新建方案';
    btn.addEventListener('click', () => openEditor('new'));
    box.appendChild(big); box.appendChild(h); box.appendChild(p);
    box.appendChild(steps); box.appendChild(document.createElement('br')); box.appendChild(btn);
    list.appendChild(box);
  }
}

/* ── 勾选持久化 / 应用 ─────────────────── */
async function persistSel() {
  renderApplyBtn();
  renderStatus();
  try { await rpc('set_active', { ids: [...S.sel] }); }
  catch (e) { toast(String(e.message || e), true); }
}

function renderApplyBtn() {
  const n = S.sel ? S.sel.size : 0;
  $('#applyText').textContent = n ? `应用到 hosts(${n})` : '应用到 hosts';
  $('#btnApply').title = n
    ? `合并:公共配置 + ${n} 个勾选方案,写入系统 hosts`
    : '未勾选方案:仅把公共配置写回系统 hosts';
}

async function applyNow() {
  const btn = $('#btnApply');
  btn.disabled = true;
  const old = $('#applyText').textContent;
  $('#applyText').textContent = '写入中…';
  try {
    const r = await rpc('apply', { ids: [...S.sel] });
    await refresh();
    if (r && r.flushed) toast(`已写入 hosts · 公共配置 + ${r.schemes} 个方案 · 已刷新系统 DNS 缓存`);
    else toast('已写入 hosts(DNS 缓存刷新失败,可手动执行 ipconfig /flushdns)');
  } catch (e) {
    toast(String(e.message || e), true);
    renderAll();
  } finally {
    btn.disabled = false;
    $('#applyText').textContent = old;
    renderApplyBtn();
  }
}
$('#btnApply').addEventListener('click', applyNow);

/* ── 右键菜单 ─────────────────────────── */
function openCtx(id, pos) {
  closeCtx();
  S.ctxFor = id;
  const card = document.querySelector('#list .card[data-id="' + id + '"]');
  if (card) card.classList.add('ctx-open');
  const ctx = $('#ctx');
  ctx.classList.add('on');
  const r = ctx.getBoundingClientRect();
  const x = Math.max(6, Math.min(pos.left, window.innerWidth - r.width - 8));
  const y = Math.max(6, Math.min(pos.top, window.innerHeight - r.height - 8));
  ctx.style.left = x + 'px';
  ctx.style.top = y + 'px';
}
function closeCtx() {
  S.ctxFor = null;
  $('#ctx').classList.remove('on');
  document.querySelectorAll('#list .card.ctx-open').forEach(el => el.classList.remove('ctx-open'));
}
document.addEventListener('click', e => {
  if (!e.target.closest || !e.target.closest('#ctx')) closeCtx();
});
$('#ctx').addEventListener('click', e => {
  const item = e.target.closest('.ctxi');
  if (!item || !S.ctxFor) return;
  const act = item.dataset.act;
  const id = S.ctxFor;
  closeCtx();
  ctxAction(act, id);
});

async function ctxAction(act, id) {
  const sc = ((S.st && S.st.schemes) || []).find(s => s.id === id);
  if (!sc) return;
  if (act === 'apply') {
    if (!S.sel.has(id)) { S.sel.add(id); await persistSel(); }
    applyNow();
  } else if (act === 'edit') {
    openEditor('edit', sc);
  } else if (act === 'rename') {
    promptModal('重命名方案', sc.name, async val => {
      const name = String(val || '').trim();
      if (!name) { toast('方案名不能为空', true); return; }
      try {
        await rpc('update_scheme', { id, name });
        await refresh();
        toast('已重命名');
      } catch (e) { toast(String(e.message || e), true); }
    });
  } else if (act === 'dup') {
    try {
      await rpc('create_scheme', { name: sc.name + ' 副本', content: sc.content });
      await refresh();
      toast('已创建副本(未勾选)');
    } catch (e) { toast(String(e.message || e), true); }
  } else if (act === 'del') {
    confirmModal('删除方案', `确定删除「${sc.name}」?该操作不可撤销。`, async () => {
      try {
        await rpc('delete_scheme', { id });
        await refresh();
        toast(`已删除「${sc.name}」· 当前 hosts 若含其内容,重新应用即可移除`);
      } catch (e) { toast(String(e.message || e), true); }
    }, true);
  }
}

/* ── 弹窗(确认 / 输入) ────────────────── */
/* 双击的第二次 click 会落在刚弹出的遮罩/弹窗上,用时间窗防「闪开即关」 */
let overlayOpenedAt = 0;
let modalOnOk = null;
function showModal(opt) {
  overlayOpenedAt = Date.now();
  $('#mdTitle').textContent = opt.title || '确认';
  $('#mdBody').textContent = opt.body || '';
  const inp = $('#mdInput');
  inp.classList.toggle('hidden', !opt.input);
  if (opt.input) inp.value = opt.value || '';
  const ok = $('#btnMdOk');
  ok.textContent = opt.okText || '确定';
  ok.classList.toggle('danger', !!opt.danger);
  modalOnOk = opt.onOk || null;
  $('#modal').classList.add('on');
  syncMask();
  if (opt.input) { inp.focus(); inp.select(); }
}
function hideModal() { $('#modal').classList.remove('on'); syncMask(); }
function confirmModal(title, body, onOk, danger) {
  showModal({ title, body, okText: danger ? '删除' : '确定', danger, onOk });
}
function promptModal(title, value, onOk) {
  showModal({ title, input: true, value, okText: '确定', onOk });
}
$('#btnMdOk').addEventListener('click', () => {
  const f = modalOnOk;
  const v = $('#mdInput').value;
  hideModal();
  if (f) f(v);
});
$('#btnMdCancel').addEventListener('click', hideModal);
$('#mdInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#btnMdOk').click(); }
  else if (e.key === 'Escape') { e.preventDefault(); hideModal(); }
});
$('#modal').addEventListener('click', e => {
  if (e.target !== $('#modal') || Date.now() - overlayOpenedAt < 300) return;
  hideModal();
});

/* ── 抽屉开关 ─────────────────────────── */
function openDrawer(sel) { overlayOpenedAt = Date.now(); $(sel).classList.add('on'); syncMask(); }
function closeDrawer(sel) { $(sel).classList.remove('on'); syncMask(); }
function syncMask() {
  const any = document.querySelector('.drawer.on, #modal.on');
  $('#mask').classList.toggle('on', !!any);
}
$('#mask').addEventListener('click', () => {
  if (Date.now() - overlayOpenedAt < 300) return;
  const ed = document.querySelector('#edDrawer.on');
  if (ed) closeEditor(false);
  closeDrawer('#pvDrawer');
  closeDrawer('#hpDrawer');
});

/* ── 预览抽屉 ─────────────────────────── */
async function openPreview() {
  try {
    const ids = [...S.sel];
    const r = await rpc('preview', { ids });
    $('#pvText').textContent = r.merged || '(合并结果为空)';
    $('#pvMeta').textContent = ids.length ? `公共配置 + ${ids.length} 个方案` : '仅公共配置(未勾选方案)';
    openDrawer('#pvDrawer');
  } catch (e) { toast(String(e.message || e), true); }
}
$('#btnPreview').addEventListener('click', openPreview);
$('#btnPvClose').addEventListener('click', () => closeDrawer('#pvDrawer'));
$('#btnPvApply').addEventListener('click', () => {
  closeDrawer('#pvDrawer');
  applyNow();
});
$('#btnPvCopy').addEventListener('click', async () => {
  const text = $('#pvText').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制合并结果');
  } catch (e) {
    /* WebView2 剪贴板权限缺失时的同步回退 */
    const ta = $('#pvText');
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ta);
    sel.removeAllRanges();
    sel.addRange(range);
    if (document.execCommand('copy')) toast('已复制合并结果');
    else toast('复制失败,请手动选择文本复制', true);
    sel.removeAllRanges();
  }
});

/* ── 帮助抽屉 ─────────────────────────── */
$('#btnHelp').addEventListener('click', () => openDrawer('#hpDrawer'));
$('#btnHpClose').addEventListener('click', () => closeDrawer('#hpDrawer'));
$('#btnFlush').addEventListener('click', async () => {
  try {
    await rpc('flush_dns', {});
    toast('已刷新系统 DNS 缓存');
  } catch (e) { toast(String(e.message || e), true); }
});
$('#btnReveal').addEventListener('click', async () => {
  try { await rpc('reveal_hosts', {}); } catch (e) { toast(String(e.message || e), true); }
});

/* ── 状态栏 ───────────────────────────── */
function renderStatus() {
  const dot = $('#stDot');
  const txt = $('#stText');
  const st = S.st;
  $('#stPath').textContent = st ? st.hosts_path : '';
  if (!st) { txt.textContent = '连接插件中…'; return; }
  if (!st.readable) {
    dot.className = 'dot err';
    txt.textContent = '无法读取 hosts 文件';
    return;
  }
  if (!st.writable) {
    dot.className = 'dot err';
    txt.textContent = 'hosts 文件不可写 · 点右上角「帮助」查看自救步骤';
    return;
  }
  if (st.external_changed) {
    dot.className = 'dot warn';
    txt.textContent = 'hosts 在插件外被修改过,重新应用即可覆盖';
    return;
  }
  if (!st.last_applied_ms) {
    dot.className = 'dot';
    txt.textContent = '尚未应用过 · 勾选方案后双击或点「应用到 hosts」';
    return;
  }
  const applied = new Set(st.last_applied_ids || []);
  if (setsEqual(S.sel, applied)) {
    dot.className = 'dot ok';
    txt.textContent = `已同步:公共配置 + ${applied.size} 个方案 · ${relTime(st.last_applied_ms)}应用`;
  } else {
    dot.className = 'dot warn';
    txt.textContent = '勾选有变化,应用后生效';
  }
}
$('#stPath').addEventListener('click', async () => {
  try { await rpc('reveal_hosts', {}); } catch (e) { toast(String(e.message || e), true); }
});

/* ── 顶栏其它入口 ─────────────────────── */
$('#btnBase').addEventListener('click', () => { if (S.st) openEditor('base'); });
$('#btnNew').addEventListener('click', () => openEditor('new'));

/* ── 页面加固:屏蔽默认右键菜单与浏览器快捷键 ── */
document.addEventListener('contextmenu', e => {
  /* 输入框/文本域保留系统菜单(剪切/复制/粘贴);方案卡自定义右键菜单不受影响 */
  if (e.target && e.target.closest && e.target.closest('input, textarea')) return;
  e.preventDefault();
});
document.addEventListener('keydown', e => {
  const k = (e.key || '').toLowerCase();
  const editing = e.target && e.target.closest && e.target.closest('input, textarea');
  /* DevTools / 打印 / 刷新:任何焦点都拦(F12、F5、Ctrl+Shift+I/J/C、Ctrl+P) */
  if (k === 'f12' || k === 'f5' ||
      (e.shiftKey && (e.ctrlKey || e.metaKey) && (k === 'i' || k === 'j' || k === 'c')) ||
      ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'p')) {
    e.preventDefault();
    return;
  }
  /* Ctrl+R:编辑器里是 vim 的 redo,放行;其余位置(会整页刷新)拦截 */
  if (!editing && (e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'r') {
    e.preventDefault();
  }
}, true);

/* ── 全局 Esc:菜单 → 弹窗 → 抽屉 ──────── */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if ($('#ctx').classList.contains('on')) { closeCtx(); return; }
  if ($('#modal').classList.contains('on')) { hideModal(); return; }
  if ($('#edDrawer').classList.contains('on')) { closeEditor(false); return; }
  closeDrawer('#pvDrawer');
  closeDrawer('#hpDrawer');
});

/* ── 启动 ─────────────────────────────── */
(async function init() {
  try {
    await refresh();
  } catch (e) {
    $('#stText').textContent = '连接插件失败';
    $('#stPath').textContent = '';
    toast(String(e.message || e), true);
  }
})();