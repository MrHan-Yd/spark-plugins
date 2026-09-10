/* ── 正则编辑器 · 页面接线 ────────────────────────────────── */
(function () {
  'use strict';

  /* ── 页面加固：屏蔽默认右键菜单与浏览器快捷键 ── */
  document.addEventListener('contextmenu', function (e) {
    if (e.target && e.target.closest && e.target.closest('input, textarea')) return;
    e.preventDefault();
  });
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    var editing = e.target && e.target.closest && e.target.closest('input, textarea');
    if (k === 'f12' || k === 'f5' ||
      (e.shiftKey && (e.ctrlKey || e.metaKey) && (k === 'i' || k === 'j' || k === 'c')) ||
      ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'p')) {
      e.preventDefault();
      return;
    }
    if (!editing && (e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'r') {
      e.preventDefault();
    }
  }, true);

  /* ── 小工具 ── */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }
  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  /* ── 悬停提示：带 data-tip 的元素即时浮现说明 ── */
  var elTip = $('tip');
  function showTip(t) {
    elTip.textContent = t.dataset.tip;
    elTip.classList.add('show');
    var r = t.getBoundingClientRect();
    var tw = elTip.offsetWidth, th = elTip.offsetHeight;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), window.innerWidth - tw - 8);
    var top = r.top - th - 8;
    if (top < 8) top = r.bottom + 8;
    elTip.style.left = left + 'px';
    elTip.style.top = top + 'px';
  }
  document.addEventListener('mouseover', function (e) {
    var t = e.target.closest && e.target.closest('[data-tip]');
    if (t) showTip(t);
  });
  document.addEventListener('mouseout', function (e) {
    var t = e.target.closest && e.target.closest('[data-tip]');
    if (t && !(e.relatedTarget && t.contains(e.relatedTarget))) elTip.classList.remove('show');
  });
  function setStat(el, cls, text) {
    el.classList.remove('err', 'ok', 'warn');
    if (cls) el.classList.add(cls);
    el.textContent = text;
  }
  function nz(v, d) { return (v === null || v === undefined) ? d : v; }
  function hasSpark() { return typeof window.spark !== 'undefined' && window.spark; }

  function copyText(s, okMsg) {
    var done = function () { if (okMsg) toast(okMsg); };
    try {
      if (hasSpark() && spark.clipboard && spark.clipboard.writeText) {
        spark.clipboard.writeText(s).then(done, function () { legacy(); });
        return;
      }
    } catch (e) { /* fallthrough */ }
    legacy();
    function legacy() {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(s).then(done, function () { exec(); });
      } else exec();
    }
    function exec() {
      var ta = document.createElement('textarea');
      ta.value = s;
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择复制'); }
      document.body.removeChild(ta);
    }
  }

  function dbSet(key, val) {
    try {
      if (hasSpark() && spark.db) spark.db.set('rl_' + key, val);
    } catch (e) { /* 存储失败不影响功能 */ }
  }
  function dbGet(key) {
    try {
      if (hasSpark() && spark.db) return spark.db.get('rl_' + key);
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ── 元素 ── */
  var elPattern = $('pattern'), elContent = $('content'), elHl = $('hl'), elCodebox = $('codebox');
  var elMatchStat = $('matchStat'), elMatchHint = $('matchHint'), elMlist = $('mlist');
  var elRepl = $('repl'), elReplStat = $('replStat');
  var elContentStat = $('contentStat'), elStL = $('stL'), elStR = $('stR');
  var elExplainBar = $('explainBar');
  var flagEls = Array.prototype.slice.call(document.querySelectorAll('#flagchips .chip'));
  var elReplPreview = $('replPreview');

  var matcher = new RegexMatcher.Matcher();
  var runSeq = 0;
  var lastMatches = [];

  var HL_MAX_CHARS = 524288;   /* 高亮预览的内容上限（超限只计数不高亮） */
  var HL_MAX_MARKS = 2000;
  var LIST_SHOW = 200;         /* 匹配列表最多显示条数 */
  var WORK_TEXT_CAP = 67108864;/* 发给 Worker 的内容上限（64M 字符） */

  /* ── 标志位 ── */
  function flagsStr() {
    var on = {};
    flagEls.forEach(function (c) { if (c.classList.contains('on')) on[c.dataset.flag] = 1; });
    return ['g', 'i', 'm', 's', 'u'].filter(function (f) { return on[f]; }).join('');
  }
  function setFlags(fs) {
    flagEls.forEach(function (c) {
      c.classList.toggle('on', fs.indexOf(c.dataset.flag) >= 0);
    });
  }
  flagEls.forEach(function (c) {
    c.addEventListener('click', function () {
      c.classList.toggle('on');
      saveStateDebounced();
      runTest();
    });
  });

  /* ── 状态栏 ── */
  function status(cls, text) { setStat(elStL, cls, text); }

  function updateContentStat() {
    var n = elContent.value.length;
    elContentStat.textContent = fmt(n) + ' 字符' + (n > 1048576 ? '（≈' + (n / 1048576).toFixed(1) + 'M）' : '');
  }

  /* ── 匹配测试（Worker + 看门狗） ── */
  /* 无 mark 时直接走 nohl 态（textarea 原生显示文本，hl 层隐藏），
     大内容下不再每次全量 esc + innerHTML 重渲 */
  function showPlain() {
    elCodebox.classList.add('nohl');
  }
  function runTest() {
    var pattern = elPattern.value;
    var flags = flagsStr();
    var text = elContent.value;
    var seq = ++runSeq;

    lastMatches = [];
    hlNote = '';
    showPlain();
    elMlist.innerHTML = '<div class="mempty">输入正则后自动测试；右侧可从示例生成或扫描内容。</div>';
    elMatchHint.textContent = '';
    setStat(elReplStat, '', '');
    elReplPreview.hidden = true;

    if (!pattern) {
      setStat(elMatchStat, '', '');
      status('', '就绪');
      return;
    }
    if (text.length > WORK_TEXT_CAP) {
      setStat(elMatchStat, 'err', '内容超过 64M 字符，超出安全上限');
      status('err', '内容过大，请截断后再测');
      return;
    }

    setStat(elMatchStat, '', '测试中…');

    matcher.match(pattern, flags, text, { maxList: 1000 }).then(function (r) {
      if (seq !== runSeq) return; /* 已被更新的输入取代 */
      if (!r.ok) {
        if (r.error === 'superseded') return; /* 被更新的请求取代，静默 */
        if (r.error === 'regexp') {
          setStat(elMatchStat, 'err', '正则无效：' + r.message);
          status('err', '正则无效');
        } else {
          setStat(elMatchStat, 'warn', '已终止：' + (r.message || '长时间无进展'));
          status('warn', '执行已终止（疑似灾难性回溯）');
        }
        elMlist.innerHTML = '<div class="mempty">—</div>';
        return;
      }

      lastMatches = r.matches || [];
      var engNote = r.engine === 'local' ? '（无 Worker，主线程分片执行）' : '';
      var statTxt = '共 ' + fmt(r.count) + ' 处匹配 · ' + r.elapsed + ' ms' + engNote;
      if (r.truncated) statTxt += '（达到 200 万计数上限，已截断）';
      if (!r.count && pattern.indexOf('^') >= 0 && pattern.indexOf('$') >= 0 && text.indexOf('\n') >= 0) {
        statTxt += flags.indexOf('m') < 0
          ? '；提示：整行锚定 ^…$ 在多行内容上需加 m 标志，或取消锚定改为片段匹配'
          : '；提示：整行锚定要求整行完全等于该模式（没有一行恰好是它）；想匹配行内片段请取消 ^…$ 锚定';
      }
      setStat(elMatchStat, r.count ? 'ok' : '', statTxt);
      status(r.count ? 'ok' : '', r.count ? '匹配完成' : '无匹配');
      elStR.textContent = r.engine === 'worker' ? 'Worker 隔离执行 · 4s 看门狗' : '主线程分片执行';

      renderHighlight(text, r.count);
      renderMatchList(text, r.count, r.truncated);
      runReplacePreview(seq);
    });
  }

  /* ── 高亮预览 ──
     有界渲染（≤512KB 内容且 ≤2000 mark 才渲染 mark 层）；
     其余情况走 nohl 纯文本直显，零渲染成本 */
  var hlNote = '';
  function renderHighlight(text, count) {
    hlNote = '';
    var okHl = $('chkHl').checked && text.length <= HL_MAX_CHARS && count > 0;
    if (!okHl) {
      showPlain();
      if (text.length > HL_MAX_CHARS) hlNote = '内容超 512KB，高亮预览停用（不影响匹配统计）';
      return;
    }
    var max = Math.min(lastMatches.length, HL_MAX_MARKS);
    var html = '', last = 0, k, m;
    for (k = 0; k < max; k++) {
      m = lastMatches[k];
      if (m.i < last) continue;
      html += esc(text.slice(last, m.i));
      html += '<mark>' + esc(text.slice(m.i, m.i + m.len)) + '</mark>';
      last = m.i + m.len;
    }
    html += esc(text.slice(last));
    elHl.innerHTML = html;
    elCodebox.classList.remove('nohl');
    if (lastMatches.length > HL_MAX_MARKS) hlNote = '高亮前 ' + HL_MAX_MARKS + ' 处';
  }

  function renderMatchList(text, count, truncated) {
    if (!count) {
      elMlist.classList.remove('few');
      elMlist.innerHTML = '<div class="mempty">没有匹配。检查正则、标志位（如需要全局请点亮 g）或测试内容。</div>';
      return;
    }
    var shown = Math.min(lastMatches.length, LIST_SHOW);
    /* 小结果集逐条浮现动画（>40 条不动画，避免大列表重排 churn） */
    elMlist.classList.toggle('few', shown <= 40);
    var html = [];
    for (var k = 0; k < shown; k++) {
      var m = lastMatches[k];
      var txt = m.len > 120 ? text.slice(m.i, m.i + 120) + '…' : text.slice(m.i, m.i + m.len);
      if (!txt.length) txt = '（空匹配）';
      var grp = '';
      if (m.groups && m.groups.length) {
        var gv = m.groups.map(function (g, i2) {
          return '$' + (i2 + 1) + '=' + (g === null ? '∅' : (g.length > 40 ? g.slice(0, 40) + '…' : g));
        }).join(' ');
        grp = '<span class="grp">' + esc(gv) + '</span>';
      }
      html.push('<div class="mitem" data-i="' + m.i + '" data-len="' + m.len + '" style="animation-delay:' + Math.min(k * 8, 240) + 'ms">' +
        '<span class="idx">' + (k + 1) + '</span>' +
        '<span class="pos">@' + fmt(m.i) + '</span>' +
        '<span class="txt">' + esc(txt) + '</span>' + grp + '</div>');
    }
    var hint = '显示前 ' + shown + ' 条 / 共 ' + fmt(count) + ' 处' + (truncated ? '（计数已截断）' : '');
    if (lastMatches.length > LIST_SHOW) hint += '，仅列出前 ' + LIST_SHOW + ' 条';
    if (hlNote) hint += '；' + hlNote;
    elMatchHint.textContent = hint;
    elMlist.innerHTML = html.join('');
  }

  elMlist.addEventListener('click', function (e) {
    var item = e.target.closest && e.target.closest('.mitem');
    if (!item) return;
    var i = +item.dataset.i, len = +item.dataset.len;
    elContent.focus();
    try { elContent.setSelectionRange(i, i + len); } catch (err) { /* ignore */ }
  });

  /* 滚动同步：预览层跟随文本域 */
  elContent.addEventListener('scroll', function () {
    elHl.scrollTop = elContent.scrollTop;
    elHl.scrollLeft = elContent.scrollLeft;
  });
  elContent.addEventListener('input', function () {
    updateContentStat();
    saveStateDebounced();
  });

  var autoRunTimer = null;
  function scheduleAutoRun() {
    /* 内容越大防抖越久，避免连续输入时反复全量测试 */
    var delay = elContent.value.length > 1000000 ? 800 : 300;
    clearTimeout(autoRunTimer);
    autoRunTimer = setTimeout(runTest, delay);
  }
  elContent.addEventListener('input', scheduleAutoRun);

  /* ── 替换预览 ── */
  var replDebounced = debounce(runTest, 400);
  elRepl.addEventListener('input', replDebounced);
  elRepl.addEventListener('input', saveStateDebounced);
  function runReplacePreviewDebounced() { runTest(); }

  function runReplacePreview(seq) {
    var repl = elRepl.value;
    if (!repl || !elPattern.value) { elReplPreview.hidden = true; return; }
    matcher.replace(elPattern.value, flagsStr(), repl, elContent.value).then(function (r) {
      if (seq !== runSeq) return;
      if (!r.ok) {
        if (r.error === 'superseded') return;
        elReplPreview.hidden = true;
        setStat(elReplStat, 'err', r.error === 'regexp' ? '正则无效' : '替换失败：' + r.message);
        return;
      }
      setStat(elReplStat, 'ok', '替换 ' + fmt(r.count) + ' 处（预览前 256K 字符区域' + (r.truncated ? '，计数已截断' : '') + '，显示前 4000 字符）');
      elReplPreview.textContent = r.preview || '（预览为空）';
      elReplPreview.hidden = false;
    });
  }

  /* ── 正则条 ── */
  elPattern.addEventListener('input', debounce(function () {
    saveStateDebounced();
    runTest();
  }, 300));
  elPattern.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); runTest(); }
  });
  $('btnRun').addEventListener('click', runTest);

  $('btnExplain').addEventListener('click', function () {
    if (!elExplainBar.hidden) { elExplainBar.hidden = true; return; }
    var segs = RegexGen.explainPattern(elPattern.value);
    elExplainBar.textContent = segs.length ? segs.join('\n') : '（空正则）';
    elExplainBar.hidden = false;
  });

  $('btnCopyPat').addEventListener('click', function () {
    if (!elPattern.value) { toast('还没有正则可复制'); return; }
    copyText(elPattern.value, '正则已复制');
  });

  /* ── 高亮开关 ── */
  $('chkHl').addEventListener('change', runTest);

  /* ── 示例数据 / 清空 ── */
  var SAMPLE = [
    '2026-09-09 10:23:41 [INFO] worker#3 192.168.1.24 - "POST /api/v2/orders" 200 34ms order=ord_8823312 user=u.zhang@example.com',
    '2026-09-09 10:23:41 [WARN] gateway 10.0.0.7 retry=2 req_id=7c9e6679-742f-41d5-a2e1-5312e60b2e1a latency=128ms',
    '2026-09-09 10:23:42 [INFO] worker#1 172.16.8.101 - "GET /static/app.v2.3.1.js" 304 2ms',
    '2026-09-09 10:23:44 [ERROR] db 10.0.0.12 - "INSERT INTO orders" timeout=5000ms trace=4f0c8e21-a6b3-49ce-9d2b-71e5c5a90f31',
    '2026-09-09 10:23:45 [INFO] mailer 192.168.1.30 - queue drain: 18 mails to ops@example.com cc=alert@example.com',
    '2026-09-09 10:24:01 [INFO] worker#2 172.16.8.55 - "PUT /api/v2/users/110233" 204 41ms id=110233 phone=13812345678',
    '2026-09-09 10:24:03 [DEBUG] cache 10.0.0.9 - hit_rate=97.3% keys=184223 evict=12 color=#1b2cff',
    '2026-09-09 10:24:07 [INFO] worker#3 192.168.1.24 - "GET /api/v2/orders?status=paid&page=3" 200 29ms total=¥1,204.50',
    '2026-09-09 10:24:09 [WARN] gateway 10.0.0.7 req_id=9f31c0de-58a2-4f0e-b1c2-99ab2d1e77c3 upstream timeout 3000ms',
    '2026-09-09 10:24:12 [INFO] worker#1 172.16.8.101 - "DELETE /api/v2/orders/ord_8823099" 200 18ms',
    '2026-09-09 10:24:15 [INFO] cron 10.0.0.3 - backup finished size=2.4G cost=312s mac=AC:DE:48:00:11:22',
    '2026-09-09 10:24:20 [ERROR] auth 192.168.1.77 - login failed user=admin@example.com attempts=5 ip=203.0.113.9',
    '2026-09-09 10:24:22 [INFO] worker#2 172.16.8.55 - "GET /healthz" 200 1ms',
    '2026-09-09 10:24:31 [INFO] mailer 192.168.1.30 - invoice #20260909 sent to finance@example.com amount=$980.00',
    '2026-09-09 10:24:40 [WARN] db 10.0.0.12 - slow query "SELECT * FROM logs WHERE ts > \'2026-09-01\'" took 4.8s',
    '2026-09-09 10:24:55 [INFO] worker#3 192.168.1.24 - "POST /api/v2/shipments" 201 55ms tracking=SF8823310023'
  ].join('\n');

  $('btnSample').addEventListener('click', function () {
    elContent.value = SAMPLE;
    updateContentStat();
    runTest();
    toast('已载入示例日志，试试右侧「分析」或「生成」');
  });

  /* 清空：两段式确认，避免误触 */
  var clearArmed = null;
  $('btnClear').addEventListener('click', function () {
    var btn = $('btnClear');
    if (clearArmed) {
      clearTimeout(clearArmed);
      clearArmed = null;
      btn.textContent = '清空';
      elContent.value = '';
      updateContentStat();
      runTest();
      toast('已清空');
      return;
    }
    btn.textContent = '再点确认';
    clearArmed = setTimeout(function () {
      clearArmed = null;
      btn.textContent = '清空';
    }, 2000);
  });

  /* ── 右侧面板：页签 ── */
  var tabs = document.querySelectorAll('.ptab');
  Array.prototype.forEach.call(tabs, function (t) {
    t.addEventListener('click', function () {
      Array.prototype.forEach.call(tabs, function (t2) { t2.classList.toggle('active', t2 === t); });
      ['gen', 'scan', 'lib'].forEach(function (name) {
        $('pane-' + name).classList.toggle('hidden', name !== t.dataset.tab);
      });
    });
  });

  /* ── 生成页 ── */
  var elExamples = $('examples');
  $('btnGenerate').addEventListener('click', function () {
    var lines = elExamples.value.split('\n');
    var res = RegexGen.fromExamples(lines, {
      anchor: $('optAnchor').checked,
      compact: $('optCompact').checked,
      fold: $('optFold').checked
    });
    var box = $('genResult');
    if (!res.pattern) {
      box.hidden = true;
      toast(res.notes[0] || '无法生成：没有可用示例');
      return;
    }
    box.hidden = false;
    $('genPattern').textContent = res.pattern;
    $('genExplain').innerHTML = res.explain.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    var noteLines = res.notes.slice();
    if (res.total && res.matched < res.total) {
      noteLines.unshift(res.matched + '/' + res.total + ' 条示例可被完整匹配，其余存在变体');
    }
    $('genNotes').textContent = noteLines.join('；');
    box.dataset.pattern = res.pattern;
    /* 锚定结果旁给出「改为片段匹配」一键去锚定 */
    $('btnDeAnchor').hidden = !$('optAnchor').checked;
  });
  $('btnDeAnchor').addEventListener('click', function () {
    $('optAnchor').checked = false;
    $('btnGenerate').click();
    toast('已改为片段匹配：取消 ^…$ 锚定，可命中行内任意位置');
  });
  $('btnGenCopy').addEventListener('click', function () {
    var p = $('genResult').dataset.pattern || $('genPattern').textContent;
    if (p) copyText(p, '正则已复制');
  });
  $('btnGenTest').addEventListener('click', function () {
    var p = $('genResult').dataset.pattern;
    if (!p) return;
    elPattern.value = p;
    /* 整行锚定 ^…$ 的生成结果在多行内容上测试需按行匹配，自动补 m 标志 */
    var fs = flagsStr();
    if (p.charAt(0) === '^' && p.charAt(p.length - 1) === '$' && fs.indexOf('m') < 0) {
      setFlags(fs + 'm');
      toast('已填入测试（检测到整行锚定，已自动加 m 按行匹配）');
    } else {
      toast('已填入测试，可继续调整');
    }
    saveStateDebounced();
    runTest();
  });
  $('btnFromContent').addEventListener('click', function () {
    var v = elContent.value;
    var s = elContent.selectionStart, e = elContent.selectionEnd;
    var sel = s < e ? v.slice(s, e) : '';
    var lines, fragMode = false, note;
    if (sel && sel.trim()) {
      lines = RegexGen.linesFromContent(sel);
      /* 边界对齐判定：选区首尾都落在行边界 → 整行模式；否则是行内片段 */
      var atLineStart = v.lastIndexOf('\n', s - 1) + 1 === s;
      var nlAfter = v.indexOf('\n', e - 1);
      var lineEnd = nlAfter < 0 ? v.length : nlAfter;
      var atLineEnd = e === lineEnd || e === lineEnd + 1;
      fragMode = !(atLineStart && atLineEnd);
      note = fragMode
        ? '检测到行内片段：已按「片段模式」生成（取消整行锚定，可命中行内任意位置）'
        : '已取选区 ' + lines.length + ' 行作为示例（按整行生成）';
    } else {
      lines = RegexGen.linesFromContent(v);
      note = '已取内容前 ' + lines.length + ' 行作为示例';
    }
    if (!lines.length) { toast('内容为空：先粘贴文本或选中一段再试'); return; }
    if (fragMode && $('optAnchor').checked) $('optAnchor').checked = false;
    toast(note);
    elExamples.value = lines.join('\n');
  });
  ['optAnchor', 'optCompact', 'optFold'].forEach(function (id) {
    $(id).addEventListener('change', saveStateDebounced);
  });

  /* ── 分析页 ── */
  var scanCancel = false, scanning = false;
  $('btnScan').addEventListener('click', function () {
    if (scanning) return;
    var text = elContent.value;
    if (!text) { toast('内容为空：先在左侧粘贴要分析的文本'); return; }
    scanCancel = false; scanning = true;
    $('btnScan').disabled = true;
    $('btnScanCancel').hidden = false;
    $('scanList').innerHTML = '';
    $('scanStats').textContent = '';
    $('scanBar').style.width = '0%';
    $('progwrap').classList.add('active');

    RegexScan.analyze(text, {
      onProgress: function (p) {
        $('scanBar').style.width = (p.done / p.total * 100).toFixed(1) + '%';
      },
      shouldCancel: function () { return scanCancel; }
    }).then(function (r) {
      scanning = false;
      $('btnScan').disabled = false;
      $('btnScanCancel').hidden = true;
      $('progwrap').classList.remove('active');
      if (r.cancelled) { $('scanStats').textContent = '已取消'; return; }
      if (r.error) { $('scanStats').textContent = r.error; return; }
      renderScan(r);
    });
  });
  $('btnScanCancel').addEventListener('click', function () { scanCancel = true; });

  function renderScan(r) {
    var st = r.stats;
    var hits = r.tokens.filter(function (t) { return t.count > 0; });
    hits.sort(function (a, b) { return b.count - a.count; });

    var bar = [
      ['字母', st.letters, '#7c6cff'], ['数字', st.digits, '#39d3c3'],
      ['汉字', st.cjk, '#f59e0b'], ['空白', st.spaces, '#64748b'], ['其它', st.others, '#475569']
    ];
    var total = Math.max(1, st.chars);
    var barHtml = bar.map(function (b) {
      return '<i style="width:' + (b[1] / total * 100).toFixed(2) + '%;background:' + b[2] + '" title="' + b[0] + ' ' + fmt(b[1]) + '"></i>';
    }).join('');
    $('scanStats').innerHTML =
      '共 ' + fmt(st.chars) + ' 字符 / ' + fmt(st.lines) + ' 行 · 扫描耗时 ' + r.elapsed + ' ms' +
      (r.truncatedScan ? '（超 128M 字符，仅扫描前段）' : '') +
      '<div class="charbar">' + barHtml + '</div>' +
      '字母 ' + pct(st.letters, total) + ' · 数字 ' + pct(st.digits, total) +
      ' · 汉字 ' + pct(st.cjk, total) + ' · 空白 ' + pct(st.spaces, total) +
      '<br>检出 ' + hits.length + ' 类高频模式：';

    if (!hits.length) {
      $('scanList').innerHTML = '<div class="sempty">没有检出常见模式。内容可能不含结构化片段，或已被计数上限截断。</div>';
      return;
    }
    $('scanList').innerHTML = hits.map(function (t, i) {
      var samples = t.samples.map(function (s) { return esc(s.length > 80 ? s.slice(0, 80) + '…' : s); }).join('　');
      var cnt = fmt(t.count) + (t.truncated ? '+' : '') + ' 处';
      var delay = Math.min(i * 40, 240);
      return '<div class="scard" data-pat="' + esc(t.pattern) + '" style="animation-delay:' + delay + 'ms">' +
        '<div class="shead"><span class="sname">' + esc(t.label) + '</span>' +
        '<span class="scount mono">' + cnt + '</span></div>' +
        '<div class="spat mono" title="点击作为正则去测试">' + esc(t.pattern) + '</div>' +
        (samples ? '<div class="ssamples">如：' + samples + '</div>' : '') +
        '<div class="srow"><button class="tb small bCopy">复制</button>' +
        '<button class="tb small primary bTest">去测试 →</button></div></div>';
    }).join('');
  }

  function pct(a, total) { return (a / Math.max(1, total) * 100).toFixed(1) + '%'; }

  $('scanList').addEventListener('click', function (e) {
    var card = e.target.closest && e.target.closest('.scard');
    if (!card) return;
    var pat = card.dataset.pat;
    if (e.target.classList.contains('bTest') || e.target.closest('.spat')) {
      elPattern.value = pat;
      saveStateDebounced();
      runTest();
      toast('已填入测试：' + pat.slice(0, 60));
    } else if (e.target.classList.contains('bCopy')) {
      copyText(pat, '正则已复制');
    }
  });

  /* ── 常用页 ── */
  var PRESETS = [
    { n: '邮箱', p: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' },
    { n: '手机号', p: '1[3-9]\\d{9}' },
    { n: 'URL', p: 'https?://[^\\s<>"\')]+' },
    { n: 'IPv4', p: '\\b(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\b' },
    { n: 'UUID', p: '\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b' },
    { n: '日期 YYYY-MM-DD', p: '\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b' },
    { n: '时间 HH:MM:SS', p: '\\b\\d{2}:\\d{2}(?::\\d{2})?\\b' },
    { n: 'ISO 日期时间', p: '\\b\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?' },
    { n: '身份证（18位）', p: '\\b\\d{17}[\\dXx]\\b' },
    { n: '十六进制颜色', p: '#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\\b' },
    { n: '整数', p: '-?\\b\\d+\\b' },
    { n: '小数', p: '-?\\b\\d+\\.\\d+\\b' },
    { n: '中文字符', p: '[\\u4e00-\\u9fa5]+' },
    { n: '空白行', p: '^[ \\t]*$', f: 'gm' },
    { n: 'HTML 标签', p: '</?[A-Za-z][\\w-]*(?:\\s+[^<>]*)?>' },
    { n: '重复单词', p: '\\b(\\w+)\\s+\\1\\b', f: 'gi' },
    { n: 'Base64 片段', p: '\\b[A-Za-z0-9+/]{20,}={0,2}\\b' },
    { n: '版本号', p: '\\b\\d+(?:\\.\\d+){1,3}\\b' },
    { n: '千分位金额', p: '[¥$€£]\\s?\\d+(?:,\\d{3})*(?:\\.\\d{1,2})?' },
    { n: '行首尾空白', p: '^[ \\t]+|[ \\t]+$', f: 'gm' },
    { n: 'QQ 号', p: '\\b[1-9]\\d{4,10}\\b' },
    { n: '图片标签', p: '<img\\s+[^>]*src="[^"]*"[^>]*>' }
  ];
  $('libGrid').innerHTML = PRESETS.map(function (x, i) {
    return '<button class="libitem" data-i="' + i + '"><b>' + esc(x.n) + '</b><span>' + esc(x.p) + '</span></button>';
  }).join('');
  $('libGrid').addEventListener('click', function (e) {
    var item = e.target.closest && e.target.closest('.libitem');
    if (!item) return;
    var x = PRESETS[+item.dataset.i];
    elPattern.value = x.p;
    setFlags(x.f || 'g');
    saveStateDebounced();
    runTest();
    toast('已应用模板：' + x.n);
  });

  /* ── 状态持久化（不含大内容） ── */
  var saveStateDebounced = debounce(function () {
    dbSet('pattern', elPattern.value);
    dbSet('flags', flagsStr());
    dbSet('examples', elExamples.value.slice(0, 100000));
    dbSet('optAnchor', $('optAnchor').checked);
    dbSet('optCompact', $('optCompact').checked);
    dbSet('optFold', $('optFold').checked);
    dbSet('chkHl', $('chkHl').checked);
    dbSet('repl', elRepl.value.slice(0, 2000));
  }, 800);

  /* ── 主题 ── */
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    dbSet('theme', t);
  }
  $('btnTheme').addEventListener('click', function () {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  /* ── 启动 ── */
  function boot(saved) {
    saved = saved || {};
    setTheme(nz(saved.theme, 'dark'));
    elPattern.value = saved.pattern || '';
    setFlags(nz(saved.flags, 'g'));
    elExamples.value = saved.examples || '';
    $('optAnchor').checked = nz(saved.optAnchor, true);
    $('optCompact').checked = nz(saved.optCompact, true);
    $('optFold').checked = nz(saved.optFold, false);
    $('chkHl').checked = nz(saved.chkHl, true);
    elRepl.value = saved.repl || '';
    updateContentStat();
    elStR.textContent = matcher.engine === 'worker' ? 'Worker 隔离执行 · 4s 看门狗' : '主线程分片执行（无 Worker）';
    runTest();

    /* 触发参数作为初始内容（regex <粘贴文本>） */
    try {
      if (hasSpark() && spark.input && spark.input.text && spark.input.text.length) {
        elContent.value = spark.input.text.length > 2097152
          ? spark.input.text.slice(0, 2097152) : spark.input.text;
        updateContentStat();
        runTest();
        toast('已载入触发参数 ' + fmt(elContent.value.length) + ' 字符');
      }
    } catch (e) { /* ignore */ }
  }

  /* 单键容错读取：任一键读取失败不影响其余恢复 */
  function dbGetSafe(key) {
    return Promise.resolve().then(function () { return dbGet(key); }).catch(function () { return null; });
  }
  Promise.all([
    dbGetSafe('pattern'), dbGetSafe('flags'), dbGetSafe('examples'),
    dbGetSafe('optAnchor'), dbGetSafe('optCompact'), dbGetSafe('optFold'),
    dbGetSafe('chkHl'), dbGetSafe('repl'), dbGetSafe('theme')
  ]).then(function (v) {
    boot({
      pattern: v[0], flags: v[1], examples: v[2], optAnchor: v[3],
      optCompact: v[4], optFold: v[5], chkHl: v[6], repl: v[7], theme: v[8]
    });
  });
})();