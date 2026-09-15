/* app.js — 密码管家 · 页面接线（渲染 / 交互 / 快捷键 / 自动锁定 / 剪贴板 / 导入导出） */

/* ── 页面加固：屏蔽默认右键菜单与浏览器快捷键 ── */
document.addEventListener('contextmenu', function (e) {
  // 输入框/文本域保留系统菜单（剪切/复制/粘贴）
  if (e.target && e.target.closest && e.target.closest('input, textarea')) return;
  e.preventDefault();
});
document.addEventListener('keydown', function (e) {
  var k = (e.key || '').toLowerCase();
  var editing = e.target && e.target.closest && e.target.closest('input, textarea');
  // DevTools / 打印 / 刷新：任何焦点都拦（F12、F5、Ctrl+Shift+I/J/C、Ctrl+P）
  if (k === 'f12' || k === 'f5' ||
    (e.shiftKey && (e.ctrlKey || e.metaKey) && (k === 'i' || k === 'j' || k === 'c')) ||
    ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'p')) {
    e.preventDefault();
    return;
  }
  // Ctrl+R：输入框/文本域内放行（页内可能作它用）；其余位置（会整页刷新）拦截
  if (!editing && (e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'r') {
    e.preventDefault();
  }
}, true);

(function () {
  'use strict';

  var hasSpark = typeof spark !== 'undefined' && spark && spark.db;

  /* ══════════ 小工具 ══════════ */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function relTime(ts) {
    if (!ts) return '—';
    var dt = Date.now() - ts;
    if (dt < 60000) return '刚刚';
    if (dt < 3600000) return Math.floor(dt / 60000) + ' 分钟前';
    if (dt < 86400000) return Math.floor(dt / 3600000) + ' 小时前';
    if (dt < 2592000000) return Math.floor(dt / 86400000) + ' 天前';
    return fmtTime(ts);
  }
  function initial(title, username, url) {
    var s = String(title || username || url || '?').replace(/^[a-z]+:\/\//i, '').trim();
    return s.charAt(0) || '?';
  }
  function siteOf(url) {
    return String(url || '').replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast' + (kind ? ' ' + kind : ''); }, 2400);
  }
  function setStatus(msg, kind) {
    var s = $('status-text');
    s.textContent = msg;
    s.parentNode.className = 'status' + (kind ? ' ' + kind : '');
  }
  function showErr(id, msg) {
    var box = $(id);
    if (!msg) { box.hidden = true; box.textContent = ''; return; }
    box.textContent = msg;
    box.hidden = false;
  }

  /* ══════════ 状态 ══════════ */
  var prefs = null;
  var view = { group: '__all', keyword: '', sort: 'order' };
  var activeId = null;
  var editingId = null;      /* null = 未在编辑；'' = 新增中 */
  var isEditing = false;
  var lockFailures = 0;
  var lockCooldownUntil = 0;
  var idleTimer = null;
  var clipTimer = null;
  var lastClipValue = null;
  var revealed = {};          /* 详情里哪些字段被显式显示 */
  var selectedIdx = -1;

  /* ══════════ 主题 ══════════ */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('btn-theme').textContent = t === 'dark' ? '🌙' : '☀️';
  }

  /* ══════════ 屏幕切换 ══════════ */
  function showScreen(name) {
    $('boot').hidden = name !== 'boot';
    $('screen-setup').hidden = name !== 'setup';
    $('screen-lock').hidden = name !== 'lock';
    $('screen-main').hidden = name !== 'main';
    if (name === 'setup') { setTimeout(function () { $('setup-pw').focus(); }, 30); }
    if (name === 'lock') { setTimeout(function () { $('lock-pw').focus(); }, 30); }
  }

  /* ══════════ 剪贴板 ══════════ */
  function copyText(text, label) {
    var done = function () {
      toast((label || '内容') + '已复制' + clipNote(), '');
      armClipboardClear(text);
    };
    if (hasSpark && spark.clipboard && spark.clipboard.writeText) {
      return spark.clipboard.writeText(text).then(done).catch(function (e) {
        if (e && e.code === 'PERMISSION_DENIED') {
          toast('剪贴板权限未授权，请在 设置 → 插件 中授予 clipboard', 'err');
        } else {
          fallbackCopy(text, done);
        }
      });
    }
    fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) done(); else toast('复制失败，请手动选中复制', 'err');
    } catch (e) { toast('复制失败，请手动选中复制', 'err'); }
  }
  function clipNote() {
    var s = prefs && prefs.clipboardClearSec;
    return s ? '，' + s + ' 秒后自动清空剪贴板' : '';
  }
  /* 复制后定时清空：仅在剪贴板内容仍是本次写入值时才清（不覆盖用户后续复制的东西） */
  function armClipboardClear(value) {
    clearTimeout(clipTimer);
    if (!prefs || !prefs.clipboardClearSec) return;
    if (!hasSpark || !spark.clipboard || !spark.clipboard.readText) return;
    lastClipValue = value;
    clipTimer = setTimeout(function () {
      spark.clipboard.readText().then(function (cur) {
        if (cur === lastClipValue) {
          lastClipValue = null;
          return spark.clipboard.writeText('');
        }
      }).catch(function () { /* 读不到就不动剪贴板 */ });
    }, prefs.clipboardClearSec * 1000);
  }

  /* ══════════ 自动锁定 ══════════ */
  function armIdleTimer() {
    clearTimeout(idleTimer);
    if (!prefs || !prefs.autoLockSec) return;
    idleTimer = setTimeout(function () {
      lockVault('长时间无操作，已自动锁定');
    }, prefs.autoLockSec * 1000);
  }
  function lockVault(reason) {
    if (!Vault.isUnlocked()) return;
    Vault.lock();
    revealed = {};
    activeId = null;
    isEditing = false;
    editingId = null;
    closePanels();
    document.body.classList.remove('has-detail');
    showScreen('lock');
    $('lock-pw').value = '';
    showErr('lock-err', '');
    $('lock-sub').textContent = reason || '输入开门密码后解密全部帐号。';
    setStatus('已锁定');
    lockFailures = 0;
    clearTimeout(idleTimer);
  }

  /* ══════════ 建库 ══════════ */
  function updateSetupStrength() {
    var pw = $('setup-pw').value;
    var box = $('setup-strength');
    if (!pw) { box.hidden = true; return; }
    var s = Vault.strength(pw);
    box.hidden = false;
    box.setAttribute('data-level', String(s.level));
    $('setup-strength-bar').style.width = Math.max(6, Math.min(100, (s.bits / 128) * 100)) + '%';
    $('setup-strength-label').textContent = s.label + '（约 ' + s.bits + ' bit 熵）';
    $('setup-strength-bits').textContent = s.level >= 3 ? '可用' : '建议再加长一点';
    var issues = $('setup-strength-issues');
    issues.innerHTML = s.issues.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('');
    issues.hidden = s.issues.length === 0;
  }

  function doSetup() {
    var pw = $('setup-pw').value, pw2 = $('setup-pw2').value;
    showErr('setup-err', '');
    if (!pw || pw.length < 6) return showErr('setup-err', '开门密码至少 6 位');
    if (pw !== pw2) return showErr('setup-err', '两次输入不一致');
    var btn = $('btn-setup');
    btn.disabled = true;
    btn.textContent = '正在加密（BCrypt 计算中…）';
    Vault.setup(pw, { hint: $('setup-hint').value.trim() }).then(function () {
      $('setup-pw').value = ''; $('setup-pw2').value = '';
      $('setup-strength').hidden = true;
      enterMain();
      toast('保险库已建立，数据已用 AES-256-CBC 加密保存');
    }).catch(function (e) {
      showErr('setup-err', '建立失败：' + (e && e.message ? e.message : e));
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '建立保险库';
    });
  }

  /* ══════════ 解锁 ══════════ */
  function doUnlock() {
    var pw = $('lock-pw').value;
    showErr('lock-err', '');
    if (!pw) return;
    var now = Date.now();
    if (now < lockCooldownUntil) {
      showErr('lock-err', '连续输错，请等待 ' + Math.ceil((lockCooldownUntil - now) / 1000) + ' 秒后重试');
      return;
    }
    var btn = $('btn-unlock');
    btn.disabled = true;
    btn.textContent = '校验中（BCrypt）…';
    Vault.unlock(pw).then(function (r) {
      lockFailures = 0;
      $('lock-pw').value = '';
      enterMain();
      toast('已解锁，共 ' + r.records + ' 条帐号');
    }).catch(function (e) {
      var code = e && e.message ? e.message : '';
      if (code === 'WRONG_PASSWORD') {
        lockFailures++;
        if (lockFailures >= 3) {
          lockCooldownUntil = Date.now() + Math.min(30, (lockFailures - 2) * 5) * 1000;
          showErr('lock-err', '开门密码错误（第 ' + lockFailures + ' 次），已暂时锁定输入 ' +
            Math.min(30, (lockFailures - 2) * 5) + ' 秒');
        } else {
          showErr('lock-err', '开门密码错误');
        }
      } else if (code === 'VAULT_CORRUPT') {
        showErr('lock-err', '数据损坏：密文与校验块不匹配，保险库无法解密');
      } else {
        showErr('lock-err', '解锁失败：' + code);
      }
      $('lock-pw').select();
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '开门';
    });
  }

  function enterMain() {
    showScreen('main');
    syncPrefsToUI();
    if (hasSpark && spark.input && spark.input.text) {
      view.keyword = String(spark.input.text).trim();
      $('search').value = view.keyword;
    }
    renderAll();
    setStatus('已解锁 · ' + Vault.counts().total + ' 条帐号');
    armIdleTimer();
  }

  /* ══════════ 渲染：分组 ══════════ */
  var DRAG_GROUP = null;   /* 正在拖的分组 id */

  function renderGroups() {
    var c = Vault.counts();
    var html = '';
    var virtuals = [
      { id: '__all', icon: '🗂', name: '全部帐号', n: c.total },
      { id: '__fav', icon: '★', name: '收藏', n: c.fav },
      { id: '__nogroup', icon: '⋯', name: '未分组', n: c.nogroup }
    ];
    html += virtuals.map(function (v) {
      return grpHtml(v.id, v.icon, v.name, v.n, false);
    }).join('');
    html += '<div class="grp-sep"></div>';
    if (!c.total && !Vault.snapshot().groups.length) {
      html += '<div class="grp" style="cursor:default;color:var(--fg-faint)">还没有分组</div>';
    }
    html += Vault.snapshot().groups.map(function (g) {
      return grpHtml(g.id, '📁', g.name, c.byGroup[g.id] || 0, true);
    }).join('');
    $('group-list').innerHTML = html;
  }
  function grpHtml(id, icon, name, n, custom) {
    var active = view.group === id || (id === '__fav' && view.group === '__fav');
    return '<div class="grp' + (active ? ' active' : '') + '" data-group="' + esc(id) + '"' +
      (custom ? ' draggable="true"' : '') + ' title="' + esc(name) + '">' +
      '<span class="grp-icon">' + icon + '</span>' +
      '<span class="grp-name">' + esc(name) + '</span>' +
      (custom ? '<span class="grp-acts">' +
        '<button data-grp-rename="' + esc(id) + '" title="重命名">✎</button>' +
        '<button data-grp-del="' + esc(id) + '" title="删除分组">🗑</button></span>' : '') +
      '<span class="grp-count">' + n + '</span></div>';
  }

  /* ══════════ 渲染：列表 ══════════ */
  function currentList() {
    var opts = { group: view.group, sort: view.sort, keyword: view.keyword };
    if (view.group === '__fav') { opts.group = ''; opts.fav = true; }
    return Vault.query(opts);
  }
  function renderList() {
    var list = currentList();
    var box = $('list');
    var head = view.group === '__all' ? '全部帐号'
      : view.group === '__fav' ? '收藏'
        : view.group === '__nogroup' ? '未分组'
          : Vault.groupName(view.group) || '分组';
    $('list-title').textContent = head;
    $('list-count').textContent = view.keyword ? '筛选出 ' + list.length + ' 条 / 共 ' + Vault.counts().total + ' 条'
      : '共 ' + list.length + ' 条';
    $('search-clear').hidden = !view.keyword;

    if (!list.length) {
      box.innerHTML = '';
      var e = $('list-empty');
      e.hidden = false;
      if (view.keyword) {
        e.innerHTML = '<div class="big-icon">🔍</div><div>没有匹配「' + esc(view.keyword) + '」的帐号</div>';
      } else if (view.group === '__fav') {
        e.innerHTML = '<div class="big-icon">★</div><div>还没有收藏的帐号</div>';
      } else {
        e.innerHTML = '<div class="big-icon">🔐</div><div>这里还没有帐号</div>' +
          '<button class="primary" id="empty-new">新增第一个帐号</button>';
        var b = $('empty-new');
        if (b) b.addEventListener('click', function () { startNew(); });
      }
      return;
    }
    $('list-empty').hidden = true;
    box.innerHTML = list.map(function (r, i) {
      return '<div class="item' + (r.id === activeId ? ' active' : '') + '" data-id="' + esc(r.id) + '"' +
        ' draggable="' + (view.sort === 'order' ? 'true' : 'false') + '" data-idx="' + i + '">' +
        '<span class="avatar" style="background:' + avatarBg(r) + '">' + esc(initial(r.title, r.username, r.url)) + '</span>' +
        '<span class="item-mid">' +
        '<span class="item-title">' + (r.fav ? '<span class="fav">★</span>' : '') + esc(r.title) +
        '<span class="tag">' + esc(Vault.groupName(r.group) || '未分组') + '</span></span>' +
        '<span class="item-sub">' +
        (r.username ? '<span>' + esc(r.username) + '</span>' : '') +
        (r.url ? '<span class="url">' + esc(siteOf(r.url)) + '</span>' : '') +
        '</span></span>' +
        '<span class="item-acts">' +
        (r.username ? '<button data-copy-user="' + esc(r.id) + '" title="复制用户名">👤</button>' : '') +
        (r.password ? '<button data-copy-pw="' + esc(r.id) + '" title="复制密码">🔑</button>' : '') +
        '</span></div>';
    }).join('');
  }
  /* 头像底色按标题哈希取固定色相，视觉上可区分且稳定 */
  function avatarBg(r) {
    var s = String(r.title || r.username || '?'), h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return 'hsl(' + h + ',' + (dark ? '42%' : '52%') + '%,' + (dark ? '26%' : '88%') + ')';
  }

  /* ══════════ 渲染：详情 / 编辑 ══════════ */
  function renderAll() {
    renderGroups();
    renderList();
    renderDetail();
    renderStatus();
  }
  function renderStatus() {
    if (!Vault.isUnlocked()) return;
    var right = [];
    var al = prefs && prefs.autoLockSec;
    right.push(al ? '自动锁定 ' + (al >= 60 ? (al / 60) + ' 分钟' : al + ' 秒') : '自动锁定已关闭');
    right.push(prefs && prefs.clipboardClearSec ? '剪贴板 ' + prefs.clipboardClearSec + 's 清空' : '剪贴板不清空');
    right.push('Ctrl+U/P 复制 · Ctrl+N 新增 · Ctrl+L 锁定');
    $('status-right').textContent = right.join(' · ');
  }

  function openDetail() { document.body.classList.add('has-detail'); }
  function closeDetail() {
    document.body.classList.remove('has-detail');
    activeId = null;
    isEditing = false;
    editingId = null;
    $('detail').innerHTML = '';   /* 清掉残留的表单/详情，避免下次打开读到旧节点 */
    renderList();
  }

  function renderDetail() {
    var box = $('detail');
    if (isEditing) { renderEdit(); return; }
    if (!activeId) {
      box.innerHTML = '';
      document.body.classList.remove('has-detail');
      return;
    }
    var r = Vault.getRecord(activeId);
    if (!r) { closeDetail(); return; }
    openDetail();
    var pwShown = !!revealed.pw;
    var hist = r.history || [];
    box.innerHTML = '<div class="detail-inner">' +
      '<div class="detail-head">' +
      '<span class="avatar" style="background:' + avatarBg(r) + ';flex-basis:38px;width:38px;height:38px">' +
      esc(initial(r.title, r.username, r.url)) + '</span>' +
      '<div class="detail-title"><h2>' + esc(r.title) + '</h2>' +
      '<div class="meta">' + (r.fav ? '★ 已收藏 · ' : '') + '更新于 ' + esc(relTime(r.updated)) + '</div></div>' +
      '<button class="detail-close" id="detail-close" title="关闭">×</button></div>' +

      '<div class="drow"><div class="drow-label">用户名</div>' +
      '<div class="drow-value">' + (r.username ? esc(r.username) : '<span style="color:var(--fg-faint)">（空）</span>') +
      (r.username ? '<button class="copy" data-copy="username" title="复制">⧉</button>' : '') + '</div></div>' +

      '<div class="drow"><div class="drow-label">密码' +
      '<button class="copy" id="toggle-pw" title="显示/隐藏" style="margin-left:auto">' + (pwShown ? '🙈' : '👁') + '</button></div>' +
      '<div class="drow-value">' + (r.password
        ? (pwShown ? esc(r.password) : '••••••••••••')
        : '<span style="color:var(--fg-faint)">（空）</span>') +
      (r.password ? '<button class="copy" data-copy="password" title="复制">⧉</button>' : '') + '</div>' +
      (r.password ? '<div class="drow-label" style="margin-top:6px">强度：' + esc(Vault.strength(r.password).label) +
        ' · 约 ' + Vault.strength(r.password).bits + ' bit</div>' : '') + '</div>' +

      (r.url ? '<div class="drow"><div class="drow-label">网址</div>' +
        '<div class="drow-value">' + esc(r.url) + '<button class="copy" data-copy="url" title="复制">⧉</button></div></div>' : '') +

      (r.group ? '<div class="drow"><div class="drow-label">分组</div>' +
        '<div class="drow-value plain">' + esc(Vault.groupName(r.group)) + '</div></div>' : '') +

      (r.tags && r.tags.length ? '<div class="drow"><div class="drow-label">标签</div><div class="drow-value plain">' +
        r.tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join(' ') + '</div></div>' : '') +

      (r.note ? '<div class="drow"><div class="drow-label">备注</div>' +
        '<div class="drow-value plain">' + esc(r.note) + '</div></div>' : '') +

      (hist.length ? '<div class="drow hist"><div class="drow-label">历史密码（最近 ' + hist.length + ' 条）' +
        '<button class="copy" id="clear-hist" title="清空历史" style="margin-left:auto">🗑</button></div>' +
        hist.map(function (h) {
          return '<div class="hist-item">' + esc('•'.repeat(Math.min(h.pw.length, 12))) +
            '<button class="copy" data-copy-hist="' + esc(h.pw) + '" title="复制这条">⧉</button>' +
            '<span class="when">' + esc(fmtTime(h.at)) + '</span></div>';
        }).join('') + '</div>' : '') +

      '<div class="drow-label" style="margin-top:18px">创建于 ' + esc(fmtTime(r.created)) + '</div>' +
      '<div class="drow-acts">' +
      '<button class="primary" id="btn-edit">编辑</button>' +
      '<button class="ghost-btn" id="btn-fav">' + (r.fav ? '取消收藏' : '收藏') + '</button>' +
      '<button class="ghost-btn danger" id="btn-del">删除</button>' +
      '</div></div>';

    $('detail-close').addEventListener('click', closeDetail);
    $('toggle-pw').addEventListener('click', function () { revealed.pw = !revealed.pw; renderDetail(); });
    $('btn-edit').addEventListener('click', function () { startEdit(activeId); });
    $('btn-fav').addEventListener('click', function () {
      Vault.upsert({ id: r.id, fav: !r.fav }).then(function () { renderAll(); renderDetail(); });
    });
    $('btn-del').addEventListener('click', function () {
      ask({ title: '删除帐号', text: '确定删除「' + r.title + '」？该操作不可撤销。', ok: '删除', danger: true })
        .then(function (yes) {
          if (!yes) return;
          Vault.remove(activeId).then(function () {
            toast('已删除');
            closeDetail();
            renderAll();
          });
        });
    });
    var clr = $('clear-hist');
    if (clr) clr.addEventListener('click', function () {
      Vault.clearHistory(r.id).then(function () { renderDetail(); toast('历史密码已清空'); });
    });
    box.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function () {
        var f = b.getAttribute('data-copy');
        copyText(r[f], { username: '用户名', password: '密码', url: '网址' }[f] || '内容');
        b.classList.add('done'); b.textContent = '✓';
        setTimeout(function () { b.classList.remove('done'); b.textContent = '⧉'; }, 1000);
      });
    });
    box.querySelectorAll('[data-copy-hist]').forEach(function (b) {
      b.addEventListener('click', function () { copyText(b.getAttribute('data-copy-hist'), '历史密码'); });
    });
  }

  /* ---------- 编辑表单 ---------- */
  function startNew() {
    isEditing = true;
    editingId = '';
    activeId = null;
    renderList();
    renderEdit();
  }
  function startEdit(id) {
    isEditing = true;
    editingId = id;
    renderEdit();
  }
  function renderEdit() {
    openDetail();
    var isNew = !editingId;
    var r = isNew ? { title: '', username: '', password: '', url: '', note: '', group: view.group.indexOf('__') === 0 ? '' : view.group, tags: [], fav: false }
      : Vault.getRecord(editingId);
    if (!r) { isEditing = false; renderDetail(); return; }
    var g = prefs && prefs.gen ? prefs.gen : { length: 16, upper: true, lower: true, digit: true, symbol: true, excludeAmbiguous: false };
    var groups = Vault.snapshot().groups;

    $('detail').innerHTML = '<div class="detail-inner">' +
      '<div class="detail-head"><div class="detail-title"><h2>' + (isNew ? '新增帐号' : '编辑帐号') + '</h2>' +
      '<div class="meta">密码在保存时用 AES-256-CBC 加密</div></div>' +
      '<button class="detail-close" id="edit-cancel" title="取消">×</button></div>' +

      '<label class="field compact"><span class="field-label">标题</span>' +
      '<input id="f-title" type="text" spellcheck="false" placeholder="例如：GitHub" value="' + esc(r.title) + '"></label>' +

      '<label class="field compact"><span class="field-label">用户名 / 帐号</span>' +
      '<input id="f-username" type="text" spellcheck="false" placeholder="登录名或邮箱" value="' + esc(r.username) + '"></label>' +

      '<label class="field compact"><span class="field-label">密码</span>' +
      '<span class="field-input"><input id="f-password" class="mono" type="text" spellcheck="false" autocomplete="off" placeholder="留空表示不设密码" value="' + esc(r.password) + '">' +
      '<button type="button" class="reveal" id="f-gen" title="生成随机密码">🎲</button></span></label>' +
      '<div class="strength" id="f-strength" hidden><div class="strength-bar"><i id="f-sbar"></i></div>' +
      '<div class="strength-text"><span id="f-slabel"></span><span id="f-sbits"></span></div></div>' +

      '<div class="gen-box" id="gen-box" hidden>' +
      '<div class="row-set"><span>长度</span><input id="g-len" type="range" min="8" max="48" value="' + g.length + '"><b id="g-len-v">' + g.length + '</b></div>' +
      '<div class="row-set"><span>大写 A-Z</span><input type="checkbox" id="g-upper"' + (g.upper !== false ? ' checked' : '') + '></div>' +
      '<div class="row-set"><span>小写 a-z</span><input type="checkbox" id="g-lower"' + (g.lower !== false ? ' checked' : '') + '></div>' +
      '<div class="row-set"><span>数字 0-9</span><input type="checkbox" id="g-digit"' + (g.digit !== false ? ' checked' : '') + '></div>' +
      '<div class="row-set"><span>符号 !@#$</span><input type="checkbox" id="g-symbol"' + (g.symbol ? ' checked' : '') + '></div>' +
      '<div class="row-set"><span>排除易混淆 Il1O0o</span><input type="checkbox" id="g-noamb"' + (g.excludeAmbiguous ? ' checked' : '') + '></div>' +
      '<div class="btn-row"><button class="primary" id="g-apply">生成并填入</button>' +
      '<button class="ghost-btn" id="g-save-default">设为默认</button></div></div>' +

      '<label class="field compact"><span class="field-label">网址</span>' +
      '<input id="f-url" type="text" spellcheck="false" placeholder="https://…" value="' + esc(r.url) + '"></label>' +

      '<label class="field compact"><span class="field-label">分组</span>' +
      '<select id="f-group" class="mini-select" style="width:100%;height:38px">' +
      '<option value="">未分组</option>' +
      groups.map(function (x) {
        return '<option value="' + esc(x.id) + '"' + (x.id === r.group ? ' selected' : '') + '>' + esc(x.name) + '</option>';
      }).join('') + '</select></label>' +

      '<label class="field compact"><span class="field-label">标签<span class="field-hint">（逗号分隔）</span></span>' +
      '<input id="f-tags" type="text" spellcheck="false" placeholder="开发, 工作" value="' + esc((r.tags || []).join(', ')) + '"></label>' +

      '<label class="field compact"><span class="field-label">备注</span>' +
      '<textarea id="f-note" class="io-text" style="height:74px" spellcheck="false" placeholder="安全问题答案、绑定手机等">' + esc(r.note) + '</textarea></label>' +

      '<label class="row-set"><span>收藏</span><input type="checkbox" id="f-fav"' + (r.fav ? ' checked' : '') + '></label>' +
      '<div class="errbox" id="edit-err" hidden></div>' +
      '<div class="drow-acts"><button class="primary" id="edit-save">保存</button>' +
      '<button class="ghost-btn" id="edit-cancel2">取消</button></div></div>';

    $('edit-cancel').addEventListener('click', cancelEdit);
    $('edit-cancel2').addEventListener('click', cancelEdit);
    $('edit-save').addEventListener('click', saveEdit);
    $('f-password').addEventListener('input', updateEditStrength);
    $('f-password').addEventListener('keydown', capsHint);
    updateEditStrength();

    $('f-gen').addEventListener('click', function () {
      var gb = $('gen-box');
      gb.hidden = !gb.hidden;
    });
    $('g-len').addEventListener('input', function () { $('g-len-v').textContent = $('g-len').value; });
    $('g-apply').addEventListener('click', function () {
      var opts = {
        length: parseInt($('g-len').value, 10),
        upper: $('g-upper').checked, lower: $('g-lower').checked,
        digit: $('g-digit').checked, symbol: $('g-symbol').checked,
        excludeAmbiguous: $('g-noamb').checked
      };
      $('f-password').value = Vault.generate(opts);
      updateEditStrength();
      toast('已生成 ' + opts.length + ' 位随机密码');
    });
    $('g-save-default').addEventListener('click', function () {
      prefs.gen = {
        length: parseInt($('g-len').value, 10),
        upper: $('g-upper').checked, lower: $('g-lower').checked,
        digit: $('g-digit').checked, symbol: $('g-symbol').checked,
        excludeAmbiguous: $('g-noamb').checked
      };
      Vault.savePrefs(prefs).then(function () { toast('已设为默认生成配置'); });
    });
    setTimeout(function () {
      var node = $(isNew ? 'f-title' : 'f-username');
      if (node) node.focus();
    }, 30);
  }

  function capsHint(e) {
    var on = false;
    try { on = e.getModifierState && e.getModifierState('CapsLock'); } catch (err) { /* 忽略 */ }
    var hint = $('edit-caps');
    if (on && !hint) {
      hint = document.createElement('div');
      hint.className = 'caps';
      hint.id = 'edit-caps';
      hint.textContent = '⚠ 大写锁定已开启（Caps Lock）';
      var f = $('f-password').closest('.field');
      f.parentNode.insertBefore(hint, f.nextSibling);
    } else if (!on && hint) { hint.remove(); }
  }

  function updateEditStrength() {
    var v = $('f-password') ? $('f-password').value : '';
    var box = $('f-strength');
    if (!box) return;
    if (!v) { box.hidden = true; return; }
    var s = Vault.strength(v);
    box.hidden = false;
    box.setAttribute('data-level', String(s.level));
    $('f-sbar').style.width = Math.max(6, Math.min(100, (s.bits / 128) * 100)) + '%';
    $('f-slabel').textContent = s.label;
    $('f-sbits').textContent = '约 ' + s.bits + ' bit' + (s.issues.length ? ' · ' + s.issues[0] : '');
  }

  function cancelEdit() {
    isEditing = false;
    editingId = null;
    if (activeId) renderDetail(); else { closeDetail(); }
    renderList();
  }

  function saveEdit() {
    var fields = {
      title: $('f-title').value.trim(),
      username: $('f-username').value.trim(),
      password: $('f-password').value,
      url: $('f-url').value.trim(),
      group: $('f-group').value,
      note: $('f-note').value,
      tags: $('f-tags').value.split(/[,，]/).map(function (t) { return t.trim(); }).filter(Boolean),
      fav: $('f-fav').checked
    };
    if (!fields.title && !fields.username && !fields.url) {
      showErr('edit-err', '至少填写标题、用户名或网址之一');
      return;
    }
    if (editingId) fields.id = editingId;
    var btn = $('edit-save');
    btn.disabled = true;
    btn.textContent = '保存中…';
    Vault.upsert(fields).then(function (res) {
      isEditing = false;
      editingId = null;
      activeId = res.record.id;
      revealed = {};
      renderAll();
      toast(res.isNew ? '已新增并加密保存' : '已保存并加密');
    }).catch(function (e) {
      showErr('edit-err', '保存失败：' + (e && e.message ? e.message : e));
      btn.disabled = false;
      btn.textContent = '保存';
    });
  }

  /* ══════════ 通用对话框 ══════════ */
  var dialogResolver = null;
  function ask(opt) {
    opt = opt || {};
    $('dialog-title').textContent = opt.title || '确认';
    $('dialog-text').textContent = opt.text || '';
    $('dialog-text').hidden = !opt.text;
    $('dialog-ok').textContent = opt.ok || '确定';
    $('dialog-ok').className = opt.danger ? 'primary danger-btn' : 'primary';
    $('dialog-cancel').hidden = opt.noCancel === true;
    showErr('dialog-err', '');
    var f = $('dialog-field');
    if (opt.input) {
      f.hidden = false;
      $('dialog-field-label').textContent = opt.inputLabel || '';
      $('dialog-field-hint').textContent = opt.inputHint || '';
      $('dialog-input').setAttribute('type', opt.password ? 'password' : 'text');
      $('dialog-input').value = '';
      $('dialog-input').placeholder = opt.placeholder || '';
    } else {
      f.hidden = true;
    }
    $('dialog').hidden = false;
    setTimeout(function () {
      var node = f.hidden ? $('dialog-ok') : $('dialog-input');
      if (node) node.focus();
    }, 30);
    return new Promise(function (resolve) { dialogResolver = resolve; });
  }
  function closeDialog(value) {
    $('dialog').hidden = true;
    var r = dialogResolver;
    dialogResolver = null;
    if (r) r(value === undefined ? null : value);
  }
  $('dialog-ok').addEventListener('click', function () {
    var f = $('dialog-field');
    if (!f.hidden) {
      var v = $('dialog-input').value;
      if (!v) { showErr('dialog-err', '请输入内容'); return; }
      closeDialog(v);
    } else closeDialog(true);
  });
  $('dialog-cancel').addEventListener('click', function () { closeDialog(null); });
  $('dialog-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('dialog-ok').click(); }
  });

  /* ══════════ 面板 ══════════ */
  function openPanel(id) {
    closePanels(true);
    $('scrim').hidden = false;
    $(id).hidden = false;
  }
  function closePanels(keepScrim) {
    ['panel-gen', 'panel-settings', 'panel-io', 'panel-help'].forEach(function (p) { $(p).hidden = true; });
    if (!keepScrim) $('scrim').hidden = true;
  }
  function anyPanelOpen() {
    return ['panel-gen', 'panel-settings', 'panel-io', 'panel-help'].some(function (p) { return !$(p).hidden; });
  }
  $('scrim').addEventListener('click', function () { closePanels(); });
  document.querySelectorAll('[data-close-panel]').forEach(function (b) {
    b.addEventListener('click', function () { closePanels(); });
  });

  /* ══════════ 设置 ══════════ */
  function syncPrefsToUI() {
    $('set-autolock').value = String(prefs.autoLockSec);
    $('set-clip').value = String(prefs.clipboardClearSec);
    $('set-blur').checked = !!prefs.lockOnBlur;
    Vault.metaInfo().then(function (m) {
      $('set-hint').textContent = m && m.hint ? m.hint : '（未设置）';
      $('set-created').textContent = m ? fmtTime(m.created) : '—';
      $('set-count').textContent = String(Vault.counts().total);
    });
  }
  $('set-autolock').addEventListener('change', function () {
    prefs.autoLockSec = parseInt(this.value, 10) || 0;
    Vault.savePrefs(prefs).then(function () { armIdleTimer(); renderStatus(); toast('已更新自动锁定'); });
  });
  $('set-clip').addEventListener('change', function () {
    prefs.clipboardClearSec = parseInt(this.value, 10) || 0;
    Vault.savePrefs(prefs).then(function () { renderStatus(); toast('已更新剪贴板清空策略'); });
  });
  $('set-blur').addEventListener('change', function () {
    prefs.lockOnBlur = this.checked;
    Vault.savePrefs(prefs).then(function () { toast(prefs.lockOnBlur ? '已开启：切走即锁定' : '已关闭：切走即锁定'); });
  });

  $('btn-change-pw').addEventListener('click', function () {
    ask({ title: '修改开门密码', text: '先验证当前开门密码。', input: true, password: true, inputLabel: '当前开门密码', ok: '下一步' })
      .then(function (oldPw) {
        if (!oldPw) return null;
        return ask({ title: '设置新开门密码', text: '新密码至少 6 位。修改后旧密码立即失效。', input: true, password: true, inputLabel: '新开门密码', ok: '下一步' })
          .then(function (np) {
            if (!np) return null;
            if (np.length < 6) { toast('新开门密码至少 6 位', 'err'); return null; }
            return ask({ title: '确认新开门密码', input: true, password: true, inputLabel: '再输一次', ok: '确认修改' })
              .then(function (np2) {
                if (!np2) return null;
                if (np !== np2) { toast('两次输入不一致', 'err'); return null; }
                return Vault.changeMasterPassword(oldPw, np).then(function () {
                  toast('开门密码已更新，全部帐号已用新密钥重新加密');
                }).catch(function (e) {
                  toast(e.message === 'WRONG_PASSWORD' ? '当前开门密码错误' : ('修改失败：' + e.message), 'err');
                });
              });
          });
      });
  });

  $('btn-wipe').addEventListener('click', function () {
    ask({ title: '清空全部帐号', text: '将删除所有帐号与分组，开门密码保留。此操作不可撤销。', input: true, inputLabel: '输入「删除」以确认', ok: '清空', danger: true })
      .then(function (v) {
        if (v !== '删除') { if (v !== null) toast('确认文字不匹配，已取消', 'warn'); return; }
        return Vault.wipeRecords().then(function () {
          closeDetail();
          renderAll();
          toast('已清空全部帐号');
        });
      });
  });
  $('btn-destroy').addEventListener('click', function () {
    ask({ title: '销毁保险库', text: '将删除开门密码与全部密文，等同恢复出厂设置，且无法恢复。', input: true, inputLabel: '输入「销毁」以确认', ok: '销毁', danger: true })
      .then(function (v) {
        if (v !== '销毁') { if (v !== null) toast('确认文字不匹配，已取消', 'warn'); return; }
        return Vault.destroy().then(function () {
          closePanels();
          document.body.classList.remove('has-detail');
          showScreen('setup');
          $('setup-hint').value = '';
          toast('保险库已销毁');
        });
      });
  });

  /* ══════════ 导入 / 导出 ══════════ */
  function requirePassword(why) {
    function attempt(msg) {
      return ask({ title: '验证开门密码', text: msg, input: true, password: true, inputLabel: '开门密码', ok: '继续' })
        .then(function (pw) {
          if (!pw) return null;
          return Vault.verifyPassword(pw).then(function (good) {
            if (good) return pw;
            toast('开门密码错误，请重试', 'err');
            return attempt('开门密码错误，请重新输入。');
          });
        });
    }
    return attempt(why);
  }
  function deliver(text, name, hint) {
    $('io-text').value = text;
    var p = (hasSpark && spark.clipboard && spark.clipboard.writeText)
      ? spark.clipboard.writeText(text).then(function () { return true; }).catch(function () { return false; })
      : Promise.resolve(false);
    return p.then(function (ok) {
      toast(ok ? (name + '已复制到剪贴板，请尽快粘贴保存') : (name + '已生成，请在下方文本框手动复制'), ok ? '' : 'warn');
      var box = $('io-result');
      box.hidden = false;
      box.innerHTML = '<b>' + esc(name) + '</b> 已生成（' + text.length + ' 字符）' +
        (hint ? '<br>' + esc(hint) : '') +
        '<br>内容放在下面的文本框里，可全选复制（' + (ok ? '同时已写入剪贴板' : '剪贴板不可用') + '）。';
    });
  }

  $('btn-export-enc').addEventListener('click', function () {
    Vault.exportEncrypted().then(function (pkg) {
      return deliver(JSON.stringify(pkg), '加密包',
        '换机器导入时需要本次的开门密码；文件内容本身是密文。');
    }).catch(function (e) { toast('导出失败：' + e.message, 'err'); });
  });
  $('btn-export-plain').addEventListener('click', function () {
    ask({ title: '导出明文 JSON', text: '导出内容包含所有密码明文，可被任何程序读取。确认继续？', ok: '我明白，继续', danger: true })
      .then(function (yes) {
        if (!yes) return;
        return requirePassword('导出明文前验证身份。').then(function (pw) {
          if (!pw) return;
          return Vault.exportPlain().then(function (obj) { return deliver(JSON.stringify(obj, null, 2), '明文 JSON'); });
        });
      });
  });
  $('btn-export-csv').addEventListener('click', function () {
    ask({ title: '导出 CSV', text: 'CSV 为明文，可直接导入其它密码管理器，请勿留存于公共位置。继续？', ok: '我明白，继续', danger: true })
      .then(function (yes) {
        if (!yes) return;
        return requirePassword('导出 CSV 前验证身份。').then(function (pw) {
          if (!pw) return;
          return Vault.toCsv().then(function (csv) { return deliver(csv, 'CSV'); });
        });
      });
  });

  function doImport(mode) {
    var text = $('io-text').value;
    var pw = $('io-pw').value;
    showErr('io-err', '');
    $('io-result').hidden = true;
    if (!text.trim()) return showErr('io-err', '请先把要导入的内容粘贴到文本框');
    if (mode === 'replace') {
      ask({ title: '清空后导入', text: '现有全部帐号与分组将被删除，再导入粘贴的内容。不可撤销。', ok: '清空并导入', danger: true })
        .then(function (yes) {
          if (!yes) return;
          runImport(text, pw, mode);
        });
      return;
    }
    runImport(text, pw, mode);
  }
  function runImport(text, pw, mode) {
    Vault.importData(text, { mode: mode, password: pw || undefined }).then(function (r) {
      $('io-pw').value = '';
      renderAll();
      syncPrefsToUI();
      var box = $('io-result');
      box.hidden = false;
      box.innerHTML = '<b>导入完成</b><br>新增 ' + r.added + ' 条，跳过重复 ' + r.skipped + ' 条' +
        (r.groupAdded ? '，新建分组 ' + r.groupAdded + ' 个' : '') + '。<br>当前共 ' + Vault.counts().total + ' 条帐号。';
      toast('导入完成：新增 ' + r.added + ' 条');
    }).catch(function (e) {
      var m = e && e.message ? e.message : String(e);
      if (m === 'NEED_PASSWORD') m = '这是加密包，请在下方填入它的开门密码';
      else if (m === 'WRONG_PASSWORD') m = '加密包的开门密码不正确';
      showErr('io-err', m);
    });
  }
  $('btn-import-merge').addEventListener('click', function () { doImport('merge'); });
  $('btn-import-replace').addEventListener('click', function () { doImport('replace'); });

  /* ══════════ 顶栏交互 ══════════ */
  $('btn-theme').addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    prefs.theme = next;
    Vault.savePrefs(prefs);
    renderList();
  });
  $('btn-lock').addEventListener('click', function () { lockVault('已手动锁定'); });
  $('btn-new').addEventListener('click', function () { startNew(); });
  $('btn-help').addEventListener('click', function () { openPanel('panel-help'); });
  $('btn-settings').addEventListener('click', function () { syncPrefsToUI(); openPanel('panel-settings'); });
  $('btn-io').addEventListener('click', function () { openPanel('panel-io'); });
  $('btn-gen').addEventListener('click', function () {
    var g = prefs.gen || {};
    $('gen-len').value = g.length || 16;
    $('gen-len-v').textContent = $('gen-len').value;
    $('gen-upper').checked = g.upper !== false;
    $('gen-lower').checked = g.lower !== false;
    $('gen-digit').checked = g.digit !== false;
    $('gen-symbol').checked = !!g.symbol;
    $('gen-noamb').checked = !!g.excludeAmbiguous;
    renderGen();
    openPanel('panel-gen');
  });
  function genOptions() {
    return {
      length: parseInt($('gen-len').value, 10),
      upper: $('gen-upper').checked,
      lower: $('gen-lower').checked,
      digit: $('gen-digit').checked,
      symbol: $('gen-symbol').checked,
      excludeAmbiguous: $('gen-noamb').checked
    };
  }
  function renderGen() {
    var pw = Vault.generate(genOptions());
    var s = Vault.strength(pw);
    $('gen-out').textContent = pw;
    $('gen-strength').setAttribute('data-level', String(s.level));
    $('gen-sbar').style.width = Math.max(6, Math.min(100, (s.bits / 128) * 100)) + '%';
    $('gen-slabel').textContent = s.label;
    $('gen-sbits').textContent = '约 ' + s.bits + ' bit · ' + pw.length + ' 位';
  }
  $('gen-len').addEventListener('input', function () { $('gen-len-v').textContent = this.value; renderGen(); });
  ['gen-upper', 'gen-lower', 'gen-digit', 'gen-symbol', 'gen-noamb'].forEach(function (id) {
    $(id).addEventListener('change', renderGen);
  });
  $('gen-again').addEventListener('click', renderGen);
  $('gen-copy').addEventListener('click', function () {
    copyText($('gen-out').textContent, '生成的密码');
  });
  $('gen-save').addEventListener('click', function () {
    prefs.gen = genOptions();
    Vault.savePrefs(prefs).then(function () { toast('已设为默认生成配置'); });
  });

  $('search').addEventListener('input', function () {
    view.keyword = this.value;
    selectedIdx = -1;
    renderList();
  });
  $('search-clear').addEventListener('click', function () {
    view.keyword = '';
    $('search').value = '';
    renderList();
  });
  $('sort').addEventListener('change', function () {
    view.sort = this.value;
    prefs.sort = view.sort;
    Vault.savePrefs(prefs);
    renderList();
  });
  $('btn-add-group').addEventListener('click', function () {
    ask({ title: '新建分组', input: true, inputLabel: '分组名', ok: '创建' }).then(function (name) {
      if (!name) return;
      Vault.addGroup(name).then(function () {
        renderAll();
        toast('分组「' + name + '」已创建');
      }).catch(function (e) { toast(e.message, 'err'); });
    });
  });

  /* ══════════ 分组点击 / 拖拽 ══════════ */
  $('group-list').addEventListener('click', function (e) {
    var rn = e.target.closest('[data-grp-rename]');
    if (rn) {
      var gid = rn.getAttribute('data-grp-rename');
      ask({ title: '重命名分组', input: true, inputLabel: '新名称', ok: '保存' }).then(function (name) {
        if (!name) return;
        Vault.renameGroup(gid, name).then(function () { renderAll(); toast('已重命名'); })
          .catch(function (err) { toast(err.message, 'err'); });
      });
      return;
    }
    var del = e.target.closest('[data-grp-del]');
    if (del) {
      var id2 = del.getAttribute('data-grp-del');
      ask({ title: '删除分组', text: '删除后该分组内的帐号会回到「未分组」，帐号本身不会被删除。', ok: '删除', danger: true })
        .then(function (yes) {
          if (!yes) return;
          Vault.removeGroup(id2).then(function () {
            if (view.group === id2) view.group = '__all';
            renderAll();
            toast('分组已删除');
          });
        });
      return;
    }
    var g = e.target.closest('.grp');
    if (!g) return;
    view.group = g.getAttribute('data-group');
    view.keyword = '';
    $('search').value = '';
    selectedIdx = -1;
    renderAll();
  });

  /* 分组排序：拖动分组 */
  $('group-list').addEventListener('dragstart', function (e) {
    var g = e.target.closest('.grp[draggable="true"]');
    if (!g) return;
    DRAG_GROUP = g.getAttribute('data-group');
    g.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', 'group:' + DRAG_GROUP); } catch (err) { /* 忽略 */ }
    e.dataTransfer.effectAllowed = 'move';
  });
  $('group-list').addEventListener('dragend', function () {
    DRAG_GROUP = null;
    $('group-list').querySelectorAll('.grp').forEach(function (n) { n.classList.remove('dragging', 'dragover'); });
  });
  $('group-list').addEventListener('dragover', function (e) {
    var g = e.target.closest('.grp');
    if (!g) return;
    e.preventDefault();
    $('group-list').querySelectorAll('.grp').forEach(function (n) { n.classList.remove('dragover'); });
    g.classList.add('dragover');
  });
  $('group-list').addEventListener('drop', function (e) {
    e.preventDefault();
    var g = e.target.closest('.grp');
    $('group-list').querySelectorAll('.grp').forEach(function (n) { n.classList.remove('dragover'); });
    if (!g) return;
    var gid = g.getAttribute('data-group');
    var payload = '';
    try { payload = e.dataTransfer.getData('text/plain') || ''; } catch (err) { /* 忽略 */ }
    /* 拖的是分组 → 排序 */
    if (DRAG_GROUP && DRAG_GROUP !== gid) {
      var ids = Vault.snapshot().groups.map(function (x) { return x.id; });
      var from = ids.indexOf(DRAG_GROUP), to = ids.indexOf(gid);
      if (from < 0 || to < 0) return;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      Vault.reorderGroups(ids).then(function () { renderAll(); });
      DRAG_GROUP = null;
      return;
    }
    /* 拖的是帐号 → 移动分组 */
    var rid = payload.indexOf('record:') === 0 ? payload.slice(7) : '';
    if (!rid) return;
    var target = gid === '__fav' ? null : gid;
    if (gid === '__fav') {
      Vault.upsert({ id: rid, fav: true }).then(function () { renderAll(); toast('已加入收藏'); });
      return;
    }
    if (gid === '__all') { renderAll(); return; }
    var group = gid === '__nogroup' ? '' : gid;
    var rec = Vault.getRecord(rid);
    if (!rec) return;
    if (rec.group === group) return;
    Vault.upsert({ id: rid, group: group }).then(function () {
      renderAll();
      toast(group ? '已移动到「' + Vault.groupName(group) + '」' : '已移出分组');
    });
  });

  /* ══════════ 列表交互 / 拖拽排序 ══════════ */
  $('list').addEventListener('click', function (e) {
    var cu = e.target.closest('[data-copy-user]');
    if (cu) {
      var r1 = Vault.getRecord(cu.getAttribute('data-copy-user'));
      if (r1) { copyText(r1.username, '用户名'); flashBtn(cu); }
      return;
    }
    var cp = e.target.closest('[data-copy-pw]');
    if (cp) {
      var r2 = Vault.getRecord(cp.getAttribute('data-copy-pw'));
      if (r2) { copyText(r2.password, '密码'); flashBtn(cp); }
      return;
    }
    var item = e.target.closest('.item');
    if (!item) return;
    selectRecord(item.getAttribute('data-id'));
  });
  function flashBtn(b) {
    b.classList.add('done'); var old = b.textContent; b.textContent = '✓';
    setTimeout(function () { b.classList.remove('done'); b.textContent = old; }, 900);
  }
  function selectRecord(id) {
    activeId = id;
    selectedIdx = currentList().findIndex(function (r) { return r.id === id; });
    revealed = {};
    isEditing = false;
    editingId = null;
    renderList();
    renderDetail();
  }
  $('list').addEventListener('dblclick', function (e) {
    var item = e.target.closest('.item');
    if (!item) return;
    var r = Vault.getRecord(item.getAttribute('data-id'));
    if (r && r.password) copyText(r.password, '密码');
  });

  var dragId = null;
  $('list').addEventListener('dragstart', function (e) {
    var item = e.target.closest('.item');
    if (!item) return;
    dragId = item.getAttribute('data-id');
    item.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', 'record:' + dragId); } catch (err) { /* 忽略 */ }
    e.dataTransfer.effectAllowed = 'move';
  });
  $('list').addEventListener('dragend', function () {
    dragId = null;
    $('list').querySelectorAll('.item').forEach(function (n) { n.classList.remove('dragging', 'dropbefore', 'dropafter'); });
  });
  $('list').addEventListener('dragover', function (e) {
    if (!dragId) return;
    e.preventDefault();
    var item = e.target.closest('.item');
    $('list').querySelectorAll('.item').forEach(function (n) { n.classList.remove('dropbefore', 'dropafter'); });
    if (!item || item.getAttribute('data-id') === dragId) return;
    var rect = item.getBoundingClientRect();
    item.classList.add(e.clientY < rect.top + rect.height / 2 ? 'dropbefore' : 'dropafter');
  });
  $('list').addEventListener('drop', function (e) {
    if (!dragId || view.sort !== 'order') return;
    e.preventDefault();
    var item = e.target.closest('.item');
    var ids = currentList().map(function (r) { return r.id; });
    var after = null;
    if (item) {
      var rect = item.getBoundingClientRect();
      after = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      var over = item.getAttribute('data-id');
      if (over !== dragId) {
        var to = ids.indexOf(over);
        ids.splice(ids.indexOf(dragId), 1);
        ids.splice(after === 'before' ? to : to + 1, 0, dragId);
      }
    }
    $('list').querySelectorAll('.item').forEach(function (n) { n.classList.remove('dropbefore', 'dropafter', 'dragging'); });
    dragId = null;
    Vault.reorder(ids).then(function () { renderList(); });
  });

  /* ══════════ 快捷键 ══════════ */
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    var mod = e.ctrlKey || e.metaKey;
    var inField = e.target && e.target.closest && e.target.closest('input, textarea, select');

    if (e.key === 'Escape') {
      if (!$('dialog').hidden) { closeDialog(null); return; }
      if (anyPanelOpen()) { closePanels(); return; }
      if (isEditing) { cancelEdit(); return; }
      if (activeId) { closeDetail(); renderList(); return; }
      return;
    }
    if ($('screen-main').hidden) return;

    /* Ctrl+P 在加固段被拦（不弹打印），这里复用为「复制密码」 */
    if (mod && !e.shiftKey && k === 'p') { e.preventDefault(); copyActive('password'); return; }
    if (mod && !e.shiftKey && k === 'u') { e.preventDefault(); copyActive('username'); return; }
    if (mod && !e.shiftKey && k === 'n') { e.preventDefault(); if (!isEditing) startNew(); return; }
    if (mod && !e.shiftKey && k === 'k') { e.preventDefault(); $('search').focus(); $('search').select(); return; }
    if (mod && !e.shiftKey && k === 'l') { e.preventDefault(); lockVault('已手动锁定（Ctrl+L）'); return; }

    /* 列表上下移动（输入框内不劫持方向键） */
    if (!inField && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      var list = currentList();
      if (!list.length) return;
      e.preventDefault();
      selectedIdx = selectedIdx < 0 ? (e.key === 'ArrowDown' ? 0 : list.length - 1)
        : Math.max(0, Math.min(list.length - 1, selectedIdx + (e.key === 'ArrowDown' ? 1 : -1)));
      selectRecord(list[selectedIdx].id);
      var node = $('list').querySelector('.item.active');
      if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (!inField && e.key === 'Enter' && activeId && !isEditing) { startEdit(activeId); }
  });

  function copyActive(field) {
    var r = activeId ? Vault.getRecord(activeId) : null;
    if (!r) { toast('先在列表里选一个帐号', 'warn'); return; }
    if (!r[field]) { toast(field === 'password' ? '该帐号没有密码' : '该帐号没有用户名', 'warn'); return; }
    copyText(r[field], field === 'password' ? '密码' : '用户名');
  }

  /* 任意输入唤醒计时器 + 切走即锁 */
  ['mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, function () {
      if (Vault.isUnlocked()) armIdleTimer();
    }, { passive: true });
  });
  window.addEventListener('blur', function () {
    if (prefs && prefs.lockOnBlur && Vault.isUnlocked()) lockVault('窗口失焦，已自动锁定');
  });

  /* ══════════ 各表单按钮 ══════════ */
  $('btn-setup').addEventListener('click', doSetup);
  $('setup-pw').addEventListener('input', updateSetupStrength);
  $('setup-pw2').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSetup(); });
  $('btn-unlock').addEventListener('click', doUnlock);
  $('lock-pw').addEventListener('keydown', function (e) {
    var on = false;
    try { on = e.getModifierState && e.getModifierState('CapsLock'); } catch (err) { /* 忽略 */ }
    $('lock-caps').hidden = !on;
    if (e.key === 'Enter') doUnlock();
  });
  $('lock-pw').addEventListener('keyup', function (e) {
    var on = false;
    try { on = e.getModifierState && e.getModifierState('CapsLock'); } catch (err) { /* 忽略 */ }
    if (!on) $('lock-caps').hidden = true;
  });
  $('link-reset').addEventListener('click', function (e) {
    e.preventDefault();
    ask({
      title: '格式化并重建',
      text: '这会删除现有全部密文与开门密码，重新设置一个新的保险库。原数据无法恢复。',
      input: true, inputLabel: '输入「格式化」以确认', ok: '格式化', danger: true
    }).then(function (v) {
      if (v !== '格式化') { if (v !== null) toast('确认文字不匹配，已取消', 'warn'); return; }
      Vault.destroy().then(function () {
        $('lock-hint').hidden = true;
        showScreen('setup');
        toast('已格式化，请设置新的开门密码');
      });
    });
  });

  document.querySelectorAll('[data-reveal]').forEach(function (b) {
    b.addEventListener('click', function () {
      var input = $(b.getAttribute('data-reveal'));
      if (!input) return;
      input.setAttribute('type', input.getAttribute('type') === 'password' ? 'text' : 'password');
    });
  });

  /* ══════════ 启动 ══════════ */
  Vault.loadPrefs().then(function (p) {
    prefs = p;
    applyTheme(prefs.theme || 'dark');
    view.sort = prefs.sort || 'order';
    $('sort').value = view.sort;
    return Vault.init();
  }).then(function (r) {
    if (!r.exists) { showScreen('setup'); return; }
    var hint = r.meta && r.meta.hint;
    if (hint) { $('lock-hint').hidden = false; $('lock-hint').textContent = '密码提示：' + hint; }
    showScreen('lock');
  }).catch(function (e) {
    showScreen('lock');
    showErr('lock-err', '初始化失败：' + (e && e.message ? e.message : e));
  });

  /* 窗口关闭前丢弃内存中的密钥与明文 */
  if (typeof spark !== 'undefined' && spark && spark.onClose) {
    spark.onClose(function () { try { Vault.lock(); } catch (e) { /* 忽略 */ } });
  }
  /* 预览/调试便利：⌘/Ctrl+Shift+D 打开 DevTools（加固段只拦 F12/Ctrl+Shift+I） */
  if (typeof spark !== 'undefined' && spark && spark.dev && spark.dev.openDevTools) {
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key || '').toLowerCase() === 'd') {
        e.preventDefault(); spark.dev.openDevTools();
      }
    });
  }
})();
