/* 时间转换 · UI 层(渲染与交互;日期算法全部在 engine.js,此文件不得出现) */
(function () {
'use strict';

var T = window.TimeEngine;
var sparkApi = window.spark || null;

var $ = function (id) { return document.getElementById(id); };
var els = {
  input: $('input'), kind: $('kind'), cards: $('cards'), idle: $('idle'),
  error: $('error'), errorMsg: $('error-msg'), errorCode: $('error-code'), errorHint: $('error-hint'),
  status: $('status-text'), toast: $('toast'),
  overlay: $('overlay'), help: $('help'), tplIn: $('tpl-in'), tplOut: $('tpl-out'),
  tplErr: $('tpl-err'), wcRows: $('wc-rows'), btnTheme: $('btn-theme')
};

var PRECISION_CN = { s: '秒', ms: '毫秒', us: '微秒', ns: '纳秒' };

/* ── 偏好持久化(spark.db 优先,浏览器预览回退 localStorage) ── */

var DEFAULTS = { theme: 'dark', zoneFallback: 'local', template: T.TEMPLATE_DEFAULT };
var prefs = Object.assign({}, DEFAULTS);
var saveTimer = null;

function loadPrefs() {
  if (sparkApi) {
    return sparkApi.db.get('prefs').then(function (raw) {
      if (raw && typeof raw === 'object') prefs = Object.assign({}, DEFAULTS, raw);
    }).catch(function () {});
  }
  return Promise.resolve().then(function () {
    try {
      var raw = JSON.parse(localStorage.getItem('tc-prefs') || 'null');
      if (raw) prefs = Object.assign({}, DEFAULTS, raw);
    } catch (e) { /* 忽略 */ }
  });
}

function savePrefs() {
  if (sparkApi) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { try { sparkApi.db.set('prefs', prefs); } catch (e) { /* 忽略 */ } }, 300);
  } else {
    try { localStorage.setItem('tc-prefs', JSON.stringify(prefs)); } catch (e) { /* 忽略 */ }
  }
}

/* ── 状态 ── */

var lastOkPoint = null;
var lastSource = '';

/* ── 工具 ── */

function debounce(fn, ms) {
  var t;
  return function () { clearTimeout(t); t = setTimeout(fn, ms); };
}

var toastTimer = null;
function toast(msg, isErr) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('err', !!isErr);
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, 1800);
}

function copyText(v, btn) {
  var p = sparkApi && sparkApi.clipboard
    ? sparkApi.clipboard.writeText(v)
    : (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject({ code: 'PERMISSION_DENIED' }));
  p.then(function () {
    toast('已复制:' + truncVal(v));
    if (btn) {  // 行内对勾反馈(蓝图 M6/P1)
      btn.classList.add('copied');
      setTimeout(function () { btn.classList.remove('copied'); }, 900);
    }
  }).catch(function (e) {
    toast(e && e.code === 'PERMISSION_DENIED' ? '复制失败:请在 设置-插件 中授权剪贴板' : '复制失败', true);
  });
}

function truncVal(s) { return s.length > 48 ? s.slice(0, 48) + '…' : s; }

/* 值写入 + 变更闪动(蓝图 M1):文本未变的节点不动,避免连续输入满屏闪 */
function setVal(el, text) {
  if (!el || el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

/* ── 转换管线 ── */

var runDebounced = debounce(run, 120);

function run() {
  var text = els.input.value;
  if (!text.trim()) { renderIdle(); return; }
  var res;
  try {
    res = T.parseTime(text, { nowMs: Date.now(), zoneFallback: prefs.zoneFallback });
  } catch (e) {
    res = { ok: false, error: e };
  }
  if (res.ok) {
    var cards;
    try {
      cards = T.formatAll(res.point, { template: prefs.template, humanNowMs: Date.now() });
    } catch (e) {
      res = { ok: false, error: e };
      renderError(res.error);
      return;
    }
    lastOkPoint = res.point;
    lastSource = res.point.source;
    renderOk(res, cards);
  } else {
    lastOkPoint = null;
    renderError(res.error);
  }
}

/* ── 渲染 ── */

function renderOk(res, cards) {
  els.idle.hidden = true;
  els.error.hidden = true;
  els.cards.hidden = false;
  els.cards.classList.remove('stale');
  var label = T.SOURCE_LABELS[res.point.source] || res.point.source;
  els.kind.hidden = false;
  els.kind.classList.remove('stale');
  els.kind.textContent = '识别为 ' + label;
  fillCards(cards);
  els.status.textContent = '来源 ' + label + ' · 精度 ' + PRECISION_CN[res.point.precision]
    + ' · 系统时区 ' + systemTzText();
}

function renderError(error) {
  els.idle.hidden = true;
  els.cards.hidden = false;
  els.cards.classList.add('stale');
  els.error.hidden = false;
  els.errorMsg.textContent = error && error.message ? error.message : '解析失败';
  els.errorCode.textContent = error && error.code ? error.code : '';
  if (error && error.hint) {
    els.errorHint.hidden = false;
    els.errorHint.textContent = error.hint;
  } else {
    els.errorHint.hidden = true;
  }
  els.kind.hidden = false;
  els.kind.classList.add('stale');
  els.kind.textContent = '无法识别';
  els.status.textContent = '错误 ' + (error && error.code ? error.code : '');
}

function renderIdle() {
  lastOkPoint = null;
  els.idle.hidden = false;
  els.error.hidden = true;
  els.cards.hidden = true;
  els.kind.hidden = true;
  els.status.textContent = '就绪——支持秒/毫秒/微秒/纳秒时间戳、ISO 8601、RFC 2822、中文日期、相对时间';
}

var cardEls = {
  'iso-utc': $('v-iso-utc'), 'iso-local': $('v-iso-local'), 'local': $('v-local'),
  'rfc2822': $('v-rfc2822'), 'chinese': $('v-chinese'), 'human': $('v-human'),
  'calendar': $('v-calendar')
};

function fillCards(cards) {
  cards.forEach(function (card) {
    if (card.id === 'unix') {
      card.rows.forEach(function (r, i) {
        setVal($('v-unix-' + ['s', 'ms', 'us', 'ns'][i]), r.value);
      });
      document.querySelectorAll('.row .row-value[id^="v-unix-"]').forEach(function (el) {
        el.parentElement.classList.remove('row-origin');
      });
      card.rows.forEach(function (r, i) {
        if (r.origin) {
          var el = $('v-unix-' + ['s', 'ms', 'us', 'ns'][i]);
          if (el) el.parentElement.classList.add('row-origin');
        }
      });
      $('n-unix').textContent = card.note || '';
    } else if (card.id === 'worldclock') {
      fillWorldclock(card.rows);
    } else if (card.id === 'template') {
      if (card.error) {
        setVal(els.tplOut, '');
        els.tplErr.hidden = false;
        els.tplErr.textContent = (card.error.message || '模板渲染失败') + (card.error.position !== undefined ? '(位置 ' + card.error.position + ')' : '');
      } else {
        setVal(els.tplOut, card.value);
        els.tplErr.hidden = true;
      }
      if (card.note !== undefined && els.tplIn.value !== card.note) els.tplIn.value = card.note;
    } else if (cardEls[card.id]) {
      if (card.error) {
        setVal(cardEls[card.id], '——');
        cardEls[card.id].title = card.error.message || '不可显示';
      } else {
        setVal(cardEls[card.id], card.value);
        cardEls[card.id].title = '';
      }
      if (card.id === 'iso-local') $('n-iso-local').textContent = card.note || '';
    }
  });
}

function fillWorldclock(rows) {
  els.wcRows.textContent = '';
  rows.forEach(function (r) {
    var div = document.createElement('div');
    div.className = 'row';
    var lab = document.createElement('span');
    lab.className = 'row-label wc-label';
    lab.textContent = r.label;
    var val = document.createElement('span');
    val.className = 'row-value mono';
    val.textContent = r.value;
    val.title = '点击回填为输入';
    val.addEventListener('click', function () { useAsInput(r.value); });
    var btn = document.createElement('button');
    btn.className = 'row-copy';
    btn.textContent = '⧉';
    btn.title = '复制';
    btn.addEventListener('click', function () { copyText(r.value, btn); });
    div.appendChild(lab);
    div.appendChild(val);
    div.appendChild(btn);
    els.wcRows.appendChild(div);
  });
}

var systemTzText = function () {
  try {
    var f = T.wallClock({ epochNs: BigInt(Math.round(Date.now())) * 1000000n, precision: 'ms', zone: { kind: 'local' } }, { kind: 'system' });
    var sign = f.offsetMin >= 0 ? '+' : '-';
    var a = Math.abs(f.offsetMin);
    return f.zoneLabel + ' (UTC' + sign + (a / 60 < 10 ? '0' : '') + Math.floor(a / 60) + ':' + (a % 60 < 10 ? '0' : '') + a % 60 + ')';
  } catch (e) { return '本地'; }
};

/* ── 交互 ── */

function useAsInput(v) {
  els.input.value = v;
  run();
  els.input.focus();
  els.input.setSelectionRange(els.input.value.length, els.input.value.length);
  els.input.classList.remove('pulse');
  void els.input.offsetWidth;
  els.input.classList.add('pulse');
}

els.input.addEventListener('input', runDebounced);
els.input.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); run(); }
});

document.addEventListener('click', function (e) {
  var copyBtn = e.target.closest && e.target.closest('[data-copy]');
  if (copyBtn) {
    var src = $(copyBtn.getAttribute('data-val'));
    if (src) copyText(src.textContent, copyBtn);
    return;
  }
  var useBtn = e.target.closest && e.target.closest('[data-use]');
  if (useBtn) {
    var src2 = $(useBtn.getAttribute('data-val'));
    if (src2 && src2.textContent) useAsInput(src2.textContent);
    return;
  }
  var chip = e.target.closest && e.target.closest('.chip');
  if (chip) {
    els.input.value = chip.getAttribute('data-fill');
    run();
    els.input.focus();
    return;
  }
  /* 单值卡值点击回填(蓝图 §3.7/M5;日历卡无回填语义,'——' 为错误占位) */
  var cardVal = e.target.closest && e.target.closest('.card-value, #tpl-out');
  if (cardVal && cardVal.id !== 'v-calendar' && cardVal.textContent && cardVal.textContent !== '——') {
    useAsInput(cardVal.textContent);
    return;
  }
  var rowVal = e.target.closest && e.target.closest('.row-value[id^="v-unix-"]');
  if (rowVal && rowVal.textContent) useAsInput(rowVal.textContent);
});

$('btn-now').addEventListener('click', function () {
  els.input.value = String(Date.now());
  run();
  els.input.focus();
});

$('btn-clear').addEventListener('click', function () {
  els.input.value = '';
  renderIdle();
  els.input.focus();
});

function applyZone() {
  $('zone-local').classList.toggle('active', prefs.zoneFallback === 'local');
  $('zone-utc').classList.toggle('active', prefs.zoneFallback === 'utc');
}
$('zone-local').addEventListener('click', function () { setZone('local'); });
$('zone-utc').addEventListener('click', function () { setZone('utc'); });
function setZone(z) {
  if (prefs.zoneFallback === z) return;
  prefs.zoneFallback = z;
  savePrefs();
  applyZone();
  run();
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', prefs.theme);
  els.btnTheme.textContent = prefs.theme === 'dark' ? '☀️' : '🌙';
}
els.btnTheme.addEventListener('click', function () {
  prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
  savePrefs();
  applyTheme();
});

/* 模板编辑:只重渲染模板卡,不整卡重挂,保住焦点 */
els.tplIn.addEventListener('input', function () {
  prefs.template = els.tplIn.value;
  savePrefs();
  if (lastOkPoint) {
    try {
      var f = T.wallClock(lastOkPoint, { kind: 'system' });
      els.tplOut.textContent = T.renderTokens(prefs.template || T.TEMPLATE_DEFAULT, f);
      els.tplErr.hidden = true;
    } catch (e) {
      els.tplOut.textContent = '';
      els.tplErr.hidden = false;
      els.tplErr.textContent = (e && e.message ? e.message : '模板渲染失败');
    }
  }
});

/* 帮助抽屉 */
function openHelp() {
  els.overlay.hidden = false;
  requestAnimationFrame(function () { els.overlay.classList.add('show'); els.help.classList.add('open'); });
}
function closeHelp() {
  els.overlay.classList.remove('show');
  els.help.classList.remove('open');
  setTimeout(function () { els.overlay.hidden = true; }, 200);
}
$('btn-help').addEventListener('click', openHelp);
$('help-close').addEventListener('click', closeHelp);
els.overlay.addEventListener('click', closeHelp);
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && els.help.classList.contains('open')) closeHelp();
});

/* ── 帮助面板数据(全部来自 engine 常量,不另抄一份) ── */

function buildHelp() {
  var fmts = [
    ['Unix 时间戳', '1700000000 / 1700000000123 / 1700000000123456 / 1700000000123456789'],
    ['带小数秒', '1700000000.123456'],
    ['紧凑日期', '20240101 · 20240101123025'],
    ['ISO 8601 / RFC 3339', '2024-01-01T12:30:45Z · 2024-01-01 12:30+08:00 · 2024-1-1'],
    ['RFC 2822', 'Mon, 15 Sep 2026 16:30:00 +0800 · 15 Sep 26 16:30 GMT'],
    ['斜杠/点分隔', '2024/1/1 12:30 · 2024.01.01'],
    ['中文日期', '2024年1月1日 12时30分25秒 · 1月1日 · 12时30分'],
    ['时刻(今天补全)', '12:30 · 12:30:45.123'],
    ['相对时间', 'now · +3d · -2h · 1d ago · in 2 hours · 3天前 · 明天 · 上个月']
  ].map(function (r) {
    return '<tr><td class="tok">' + r[0] + '</td><td>' + r[1] + '</td></tr>';
  }).join('');
  $('help-formats').innerHTML = fmts;

  $('help-units').innerHTML = T.REL_UNITS.map(function (u) {
    return '<tr><td class="tok">' + u.unit + '</td><td>' + u.label + '</td><td>' + u.aliases.join(' · ') + '</td></tr>';
  }).join('') +
    '<tr><td class="tok">关键词</td><td>now · 今天 · 昨天 · 明天 · 前天 · 后天 · 上周 · 下周 · 上个月 · 下个月 · 去年 · 明年</td></tr>';

  $('help-tokens').innerHTML = T.TOKENS.map(function (t) {
    return '<tr><td class="tok">' + t.token + '</td><td class="ex">' + t.sample + '</td><td>' + t.desc + '</td></tr>';
  }).join('');
}

/* ── 初始化 ── */

function init() {
  applyTheme();
  applyZone();
  els.tplIn.value = prefs.template;
  buildHelp();
  var pre = '';
  if (sparkApi && sparkApi.input && sparkApi.input.text) pre = String(sparkApi.input.text).trim();
  if (pre) els.input.value = pre;
  run();
  els.input.focus();
  if (pre) els.input.setSelectionRange(pre.length, pre.length);
}

if (sparkApi && sparkApi.onEnter) {
  sparkApi.onEnter(function () { loadPrefs().then(init); });
  if (sparkApi.onClose) sparkApi.onClose(function () { savePrefs(); });
} else {
  loadPrefs().then(init);
}

/* ── 页面加固：屏蔽默认右键菜单与浏览器快捷键 ── */
document.addEventListener('contextmenu', e => {
  // 输入框/文本域保留系统菜单（剪切/复制/粘贴）
  if (e.target && e.target.closest && e.target.closest('input, textarea')) return;
  e.preventDefault();
});
document.addEventListener('keydown', e => {
  const k = (e.key || '').toLowerCase();
  const editing = e.target && e.target.closest && e.target.closest('input, textarea');
  // DevTools / 打印 / 刷新：任何焦点都拦（F12、F5、Ctrl+Shift+I/J/C、Ctrl+P）
  if (k === 'f12' || k === 'f5' ||
      (e.shiftKey && (e.ctrlKey || e.metaKey) && (k === 'i' || k === 'j' || k === 'c')) ||
      ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'p')) {
    e.preventDefault();
    return;
  }
  // Ctrl+R：输入框/文本域内放行（页内可能作它用，如编辑器 redo）；其余位置（会整页刷新）拦截
  if (!editing && (e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'r') {
    e.preventDefault();
  }
}, true);
})();