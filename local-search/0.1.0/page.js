'use strict';
const $ = s => document.querySelector(s);
const elList = $('#list'), elQ = $('#q'), elStL = $('#stL'), elStR = $('#stR');
const elBuild = $('#buildbar'), elBuildText = $('#buildtext'), elBfill = $('#bfill'), elBpct = $('#bpct');

/* ── 主题(与家族一致:localStorage 持久化) ─────────────── */
const THEME_KEY = 'localSearchTheme';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
}
applyTheme((() => { try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { return 'dark'; } })());
$('#btnTheme').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

/* ── toast ─────────────────────────────────────────────── */
let toastTimer = 0;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2400);
}

/* ── 宿主 RPC(native 页面专属;exe 经 host 懒启动) ──────── */
function hasHost() { return !!(window.spark && typeof spark.rpc === 'function'); }
async function rpc(method, args) {
  if (!hasHost()) throw new Error('HOST: 未检测到 Spark 宿主,请在 Spark 插件窗口中打开本页面');
  return await spark.rpc(method, args);
}

/* ── 工具 ──────────────────────────────────────────────── */
function fmtFiles(n) {
  if (n >= 10000) return (n / 10000).toFixed(n >= 1000000 ? 0 : 1) + ' 万';
  return String(n);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ── 搜索状态 ──────────────────────────────────────────── */
const S = { seq: 0, hits: [], sel: -1, timer: 0, poll: 0, building: false, lastText: '', cfg: null, letters: [], cfgPath: '' };

async function runSearch(isPoll) {
  const text = elQ.value.trim();
  const my = ++S.seq;
  S.lastText = text;
  if (!text) { elStL.textContent = my === 1 ? '连接插件中…' : '就绪'; }
  else { elStL.textContent = '搜索中…'; }
  const t0 = performance.now();
  try {
    const r = await rpc('search', { text });
    if (my !== S.seq) return; // 过期响应
    renderProgress(r.progress || {}); // 构建期在此调度下一次轮询
    if (S.building) {
      // 索引没建完不提供搜索:只展示进度,输入框已锁定
      renderWelcome(r.progress || {});
      elStL.textContent = '索引构建中';
      elStR.textContent = '';
      return;
    }
    const hits = r.hits || [];
    S.hits = hits;
    // 保留仍有效的选中行(构建期轮询会反复重渲染)
    S.sel = hits.length ? Math.min(Math.max(S.sel, 0), hits.length - 1) : -1;
    const ms = Math.max(1, Math.round(performance.now() - t0));
    if (!text) {
      renderWelcome(r.progress || {});
      elStL.textContent = '就绪';
      elStR.textContent = (r.progress && r.progress.files) ? `已索引 ${fmtFiles(r.progress.files)} 个文件` : '';
      return;
    }
    if (!hits.length) {
      const pr = r.progress || {};
      const driveNote = pr.drive_ready === false
        ? '<p>该盘符的索引还在构建,建完即可搜索。</p>' : '';
      elList.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'state';
      if (r.filter_only) {
        box.innerHTML = `<div class="big">${ICON_GUIDE}</div><h3>缺少可搜索的内容</h3>
          <p>「d:」只是盘符过滤;输入文件名关键词,或单独输扩展名直接浏览该类文件</p>
          <div class="tips">
            <span><code>.pdf</code> — 全盘所有 PDF(单独扩展名可直接搜)</span>
            <span><code>报告 ext:pdf</code> — 文件名含「报告」的 PDF,更精准</span>
          </div>`;
        elStL.textContent = '输入关键词';
      } else {
        box.innerHTML = `<div class="big">${ICON_NOHIT}</div><h3>未找到匹配「${escapeHtml(text)}」的文件</h3>${driveNote}
          <p>空格分词 AND · <code>ext:pdf</code> 按扩展名 · <code>d:</code> 限定盘符</p>`;
        elStL.textContent = '无结果';
      }
      elList.appendChild(box);
      elStR.textContent = `${ms} ms`;
      return;
    }
    renderHits();
    elStL.textContent = `${hits.length} 个结果`;
    elStR.textContent = `${ms} ms`;
  } catch (e) {
    if (my !== S.seq) return;
    if (isPoll) {
      // 轮询失败(exe 崩溃重建中等):静默重试,不刷 toast
      if (hasHost() && S.building) S.poll = setTimeout(() => runSearch(true), 3000);
      return;
    }
    elStL.textContent = '出错';
    toast(String(e.message || e), true);
  }
}
function scheduleSearch() {
  clearTimeout(S.timer);
  S.timer = setTimeout(runSearch, 150);
}

/* ── 渲染:进度条(构建期每 1.5s 轮询一次) ───────────────── */
const PH_DEFAULT = '输入文件名,空格分词;ext:pdf 过滤扩展名,d: 限定盘符';
function renderProgress(pr) {
  const building = pr.total > 0 && pr.done < pr.total;
  const was = S.building;
  S.building = building;
  clearTimeout(S.poll);
  elBuild.classList.toggle('hidden', !building);
  // 构建期锁定输入框:索引没建完结果不完整,避免误判「搜不到」;建完自动启用并聚焦
  elQ.disabled = building;
  elQ.placeholder = building ? '索引构建中,建完即可搜索…' : PH_DEFAULT;
  if (was && !building) elQ.focus();
  if (!building) { elBfill.classList.remove('indet'); return; }
  // 百分比 = 已扫描 / 上次全量扫描量(平滑);首次没有基线 → 流动动画
  const est = pr.est_total || 0;
  const visited = pr.visited || 0;
  if (est > 0 && visited > 0) {
    const pct = Math.max(1, Math.min(99, Math.round(visited / est * 100)));
    elBpct.textContent = pct + '%';
    elBfill.classList.remove('indet');
    elBfill.style.width = pct + '%';
  } else {
    elBpct.textContent = '';
    elBfill.style.width = '';
    elBfill.classList.add('indet');
  }
  const pending = (pr.pending || []).join(' ');
  elBuildText.textContent =
    `索引构建中 · 已扫描 ${fmtFiles(visited)} 项` +
    (pending ? ` · 进行中:${pending}` : '');
  S.poll = setTimeout(() => runSearch(true), 1500);
}

/* ── 渲染:欢迎页(空输入) ──────────────────────────────── */
function renderWelcome(pr) {
  elList.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'state';
  const building = pr.total > 0 && pr.done < pr.total;
  const stat = building
    ? `<p>索引构建中:已扫描 ${fmtFiles(pr.visited || 0)} 项,完成 ${pr.done}/${pr.total} 个盘<br>建完即可全盘秒搜</p>`
    : (pr.files ? `<p>已索引 ${fmtFiles(pr.files)} 个文件,输入即搜</p>` : '');
  box.innerHTML = `<div class="big">${ICON_WELCOME}</div><h3>本地搜索</h3>${stat}
    <div class="tips">
      <span><code>报告 计划</code> — 空格分词,文件名同时包含两个词</span>
      <span><code>ext:pdf</code> 或 <code>.pdf</code> — 按扩展名过滤</span>
      <span><code>d:</code> — 只搜 D 盘</span>
      <span>右上角「设置」可调整盘符、排除目录与结果上限</span>
    </div>`;
  elList.appendChild(box);
}

/* ── 渲染:结果列表(高亮区间为 UTF-16 下标,JS 直接切片) ── */
function hlName(name, ranges) {
  const frag = document.createDocumentFragment();
  if (!ranges || !ranges.length) { frag.appendChild(document.createTextNode(name)); return frag; }
  let pos = 0;
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  for (const [s, e] of sorted) {
    if (s < pos || s > name.length || e > name.length) continue;
    if (s > pos) frag.appendChild(document.createTextNode(name.slice(pos, s)));
    const mark = document.createElement('mark');
    mark.textContent = name.slice(s, e);
    frag.appendChild(mark);
    pos = e;
  }
  if (pos < name.length) frag.appendChild(document.createTextNode(name.slice(pos)));
  return frag;
}
const ICON_DIR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.6a2 2 0 0 1 1.6.8l1 1.4h7.8A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>';
const ICON_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M13.5 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><path d="M13.5 3v5.5H19"/></svg>';
/* 状态卡大图标(替代 emoji,随主题用 faint 灰) */
const ICON_WELCOME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.6a2 2 0 0 1 1.6.8l1 1.4h7.8A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>';
const ICON_NOHIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/><path d="M8.2 11h5.6"/></svg>';
const ICON_GUIDE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16M4 11h11M4 16h7"/></svg>';

function renderHits() {
  elList.innerHTML = '';
  const frag = document.createDocumentFragment();
  S.hits.forEach((hit, i) => {
    const row = document.createElement('div');
    row.className = 'row' + (i === S.sel ? ' sel' : '');
    row.dataset.i = i;

    const icon = document.createElement('div');
    icon.className = 'ficon' + (hit.is_dir ? '' : ' file');
    icon.innerHTML = hit.is_dir ? ICON_DIR : ICON_FILE;

    const main = document.createElement('div');
    main.className = 'main';
    const fn = document.createElement('div');
    fn.className = 'fname';
    fn.appendChild(hlName(hit.name || '', hit.highlight));
    const fd = document.createElement('div');
    fd.className = 'fdir';
    const bdi = document.createElement('bdi');
    bdi.textContent = (hit.dir || '') + (hit.name || '');
    bdi.style.unicodeBidi = 'plaintext';
    bdi.style.direction = 'ltr';
    fd.appendChild(bdi);
    main.appendChild(fn);
    main.appendChild(fd);

    const btn = (act, label, primary) => {
      const b = document.createElement('button');
      b.className = 'ab' + (primary ? ' primary' : '');
      b.textContent = label;
      b.dataset.act = act;
      return b;
    };
    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.appendChild(btn('open', '打开', true));
    acts.appendChild(btn('reveal', '位置'));
    acts.appendChild(btn('copy_path', '复制路径'));
    if (!hit.is_dir) acts.appendChild(btn('copy_file', '复制文件'));

    row.appendChild(icon);
    row.appendChild(main);
    row.appendChild(acts);
    frag.appendChild(row);
  });
  elList.appendChild(frag);
}

elList.addEventListener('click', e => {
  const btn = e.target.closest('.ab');
  const row = e.target.closest('.row');
  if (!row) return;
  const hit = S.hits[+row.dataset.i];
  if (!hit) return;
  if (btn) doAction(btn.dataset.act, hit);
  else doAction('open', hit);
});

async function doAction(act, hit) {
  try {
    await rpc(act, { path: hit.path, is_dir: hit.is_dir });
    if (act === 'copy_path') toast('已复制路径');
    else if (act === 'copy_file') toast('已复制文件');
    else if (act === 'reveal') toast('已在资源管理器中定位');
  } catch (e) {
    toast(String(e.message || e), true);
  }
}

/* ── 键盘:↑↓ 选择,Enter 打开,Esc 清空 ────────────────── */
function moveSel(d) {
  if (!S.hits.length) return;
  S.sel = (S.sel + d + S.hits.length) % S.hits.length;
  const rows = elList.querySelectorAll('.row');
  rows.forEach((r, i) => r.classList.toggle('sel', i === S.sel));
  const cur = rows[S.sel];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}
elQ.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
  else if (e.key === 'Enter') {
    const hit = S.hits[S.sel >= 0 ? S.sel : 0];
    if (hit) doAction('open', hit);
  } else if (e.key === 'Escape') {
    elQ.value = ''; syncClear(); runSearch();
  }
});
function syncClear() { $('#searchbox').classList.toggle('has-text', !!elQ.value); }
elQ.addEventListener('input', () => { syncClear(); scheduleSearch(); });
$('#btnClear').addEventListener('click', () => { elQ.value = ''; syncClear(); runSearch(); elQ.focus(); });

/* ── 设置抽屉 ──────────────────────────────────────────── */
async function openSettings() {
  try {
    const r = await rpc('get_config', {});
    S.cfg = r.config || {};
    S.letters = r.letters || [];
    S.cfgPath = r.path || '';
    renderSettings();
    $('#drawer').classList.add('on');
    $('#mask').classList.add('on');
  } catch (e) { toast(String(e.message || e), true); }
}
function closeSettings() {
  $('#drawer').classList.remove('on');
  $('#mask').classList.remove('on');
}
function renderSettings() {
  const cfg = S.cfg;
  const drives = $('#drives');
  drives.innerHTML = '';
  const keys = new Set([...(S.letters || []), ...Object.keys(cfg.drives || {})]);
  let on = 0;
  [...keys].sort().forEach(letter => {
    const enabled = cfg.drives ? cfg.drives[letter] !== false : true;
    if (enabled) on++;
    const label = document.createElement('label');
    label.className = 'drv' + (enabled ? ' on' : ' off');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = enabled;
    input.dataset.letter = letter;
    input.addEventListener('change', () => {
      label.classList.toggle('on', input.checked);
      label.classList.toggle('off', !input.checked);
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(letter));
    drives.appendChild(label);
  });
  $('#drvCount').textContent = `${on}/${keys.size} 个盘`;
  $('#excludes').value = (cfg.exclude_dirs || []).join('\n');
  $('#maxResults').value = cfg.max_results || 50;
  $('#cfgPath').textContent = `配置文件:${S.cfgPath}`;
}
async function saveSettings() {
  const drives = {};
  $('#drives').querySelectorAll('input').forEach(i => { drives[i.dataset.letter] = i.checked; });
  const exclude_dirs = $('#excludes').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const maxResults = parseInt($('#maxResults').value, 10);
  const cfg = {
    drives,
    exclude_dirs,
    max_results: Number.isFinite(maxResults) ? Math.min(200, Math.max(1, maxResults)) : 50,
  };
  try {
    await rpc('set_config', { config: cfg });
    closeSettings();
    toast('已保存,正在重建索引');
    S.seq++; runSearch();
  } catch (e) { toast(String(e.message || e), true); }
}
$('#btnSettings')?.addEventListener('click', openSettings);
$('#btnRebuild')?.addEventListener('click', async () => {
  try {
    await rpc('rebuild', {});
    toast('已开始重建索引');
    // 构建完成后轮询已停,必须主动刷一次才能让进度条出现
    S.seq++;
    runSearch(true);
  } catch (e) { toast(String(e.message || e), true); }
});
$('#btnCloseDrawer').addEventListener('click', closeSettings);
$('#btnCancelDrawer').addEventListener('click', closeSettings);
$('#mask').addEventListener('click', closeSettings);
$('#btnSave').addEventListener('click', saveSettings);

/* ── 启动 ──────────────────────────────────────────────── */
elQ.focus();
runSearch();
