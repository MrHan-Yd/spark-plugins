/* 追溯看板 · 视图层
 * 只做一件事：把模型变成 DOM。状态由 app.js 持有，这里通过 ctx.getState() 取。
 * 安全底线：trace 内容是不可信输入，全部走 textContent / createTextNode，不拼 innerHTML。
 */
var TraceRender = (function () {
  'use strict';

  var ctx = {
    getState: function () { return {}; },
    copy: function () { return Promise.resolve(); },
    loadDiff: function () { return Promise.resolve(''); }
  };

  function configure(next) {
    Object.keys(next || {}).forEach(function (k) { ctx[k] = next[k]; });
  }

  function $(id) { return document.getElementById(id); }

  function h(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'text') node.textContent = v;
        else if (k === 'cls') node.className = v;
        else if (k === 'style' && typeof v === 'object') Object.keys(v).forEach(function (sk) { node.style.setProperty(sk, v[sk]); });
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset' && typeof v === 'object') Object.keys(v).forEach(function (dk) { node.dataset[dk] = v[dk]; });
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      });
    }
    (kids || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /** 键盘激活：给 span/div 伪按钮补 Enter/Space 触发（真实 button 元素自带，不必用） */
  function onActivate(el, fn) {
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        fn(e);
      }
    });
  }

  /** 空态 v2：图形锚点（--ic-* mask 令牌）+ 原文案 + 可选 CTA。
   * 文案行保持纯文本节点 —— ui-smoke 对空态文案做正则断言，这里不能换成别的结构。 */
  function emptyState(lines, opts) {
    var box = h('div', { cls: 'empty' });
    if (opts && opts.icon) box.appendChild(h('span', { cls: 'empty-ic ic ic-' + opts.icon, 'aria-hidden': 'true' }));
    (lines || []).forEach(function (line) {
      if (line == null) return;
      box.appendChild(typeof line === 'string' ? h('div', { text: line }) : line);
    });
    if (opts && opts.cta) box.appendChild(h('div', { cls: 'empty-cta' }, [opts.cta]));
    return box;
  }

  /** 载入骨架：只在 await 窗口期存在，数据到达后整体替换（ui-smoke 的 waitFor 都在骨架清除之后） */
  function skeleton() {
    var box = h('div', { cls: 'skl' });
    [40, 92, 78].forEach(function (w) {
      box.appendChild(h('div', { cls: 'skl-row', style: { width: w + '%' } }));
    });
    return box;
  }

  /* ── 反馈 ───────────────────────────────────────────────────── */

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, isErr ? 5200 : 2600);
  }

  function setStatus(text, state) {
    $('status-text').textContent = text;
    document.body.dataset.state = state || '';
  }

  /** KPI 卡行（参考站首页四卡）：[label, 数字, 色类, 副行] */
  function kpiRow(cards) {
    var wrap = h('div', { cls: 'kpi' });
    cards.forEach(function (c) {
      wrap.appendChild(h('div', { cls: 'kpi-card ' + (c[2] || '') }, [
        h('span', { cls: 'kpi-dot' }),
        h('span', { cls: 'kpi-label', text: c[0] }),
        h('span', { cls: 'kpi-num', text: String(c[1]) }),
        h('span', { cls: 'kpi-sub', text: c[3] || '' }),
      ]));
    });
    return wrap;
  }

  /* ── 左轨 ───────────────────────────────────────────────────── */

  function renderRail() {
    var S = ctx.getState();
    var list = $('sess-list');
    clear(list);
    if (!S.index) {
      $('sess-count').textContent = '0';
      list.appendChild(emptyState(['还没有载入数据。', '点顶栏左侧按钮打开「数据源库」。']));
      return;
    }
    var sessions = S.index.sessions;
    var inScope = sessions.filter(function (s) { return ctx.inScope(s); }).length;
    $('sess-count').textContent = inScope + '/' + sessions.length;
    $('rail-title').textContent = S.module === 'session' ? '会话' : '统计范围';

    if (!sessions.length) {
      list.appendChild(emptyState(['这个来源里没有会话。']));
      return;
    }

    sessions.forEach(function (s) {
      var counts = s.counts || {};
      var errs = s.errors || {};
      var flags = h('span', { cls: 'sess-flags' });
      if (errs.protocol) flags.appendChild(h('span', { cls: 'chip chip-bad', text: '协议错 ' + errs.protocol }));
      if (errs.compliance_failed) flags.appendChild(h('span', { cls: 'chip chip-warn', text: '合规 ' + errs.compliance_failed }));
      var denied = (counts.write_attempts || 0) - (counts.write_applied || 0);
      if (denied > 0) flags.appendChild(h('span', { cls: 'chip chip-warn', text: '被拦 ' + denied }));
      if (!flags.childNodes.length) flags.appendChild(h('span', { cls: 'chip chip-ok', text: '干净' }));
      if (s.digest == null) flags.appendChild(h('span', { cls: 'chip chip-skip', text: '无摘要' }));

      var box = h('input', { type: 'checkbox', checked: ctx.inScope(s), title: '勾上就纳入四个聚合模块的统计范围' });
      box.addEventListener('change', function () { ctx.setScope(s, box.checked); });

      var main = h('button', {
        cls: 'sess' + (S.session && S.session.dir === s.dir && S.module === 'session' ? ' active' : ''),
        title: s.dir,
        onclick: function () { ctx.openSession(s); }
      }, [
        h('span', { cls: 'sess-id', text: s.session_id }),
        h('span', { cls: 'sess-meta', text: TraceAnalyze.fmtDateTime(s.started_at) + ' · ' + (s.events_count || 0) + ' 事件' }),
        h('span', { cls: 'sess-meta', text: '写盘 ' + (counts.write_applied || 0) + '/' + (counts.write_attempts || 0) + ' · 命令 ' + (counts.terminal_executed || 0) }),
        flags
      ]);

      list.appendChild(h('div', { cls: 'sess-row' }, [h('label', { cls: 'sess-chk' }, [box]), main]));
    });
  }

  /* ── 会话详情：子页签 + 独立滚动体 ───────────────────────────── */

  function subTabDefs(m) {
    var badComp = m ? m.compliance.filter(function (c) { return c.status === 'FAILED'; }).length : 0;
    return [
      { id: 'timeline', label: '时间线', n: m ? m.summary.events : 0, bad: false },
      { id: 'diff', label: '改动', n: m ? m.writes.length + m.commands.length : 0, bad: false },
      { id: 'compliance', label: '合规自检', n: m ? m.compliance.length : 0, bad: badComp > 0 },
      { id: 'denied', label: '被否决', n: m ? m.denied.length : 0, bad: m ? m.denied.length > 0 : false },
    ];
  }

  function renderSessionShell(pane) {
    var S = ctx.getState();
    clear(pane);
    var tabs = h('div', { cls: 'tabs' });
    subTabDefs(S.model).forEach(function (def) {
      var btn = h('button', {
        cls: 'tab' + (S.subTab === def.id ? ' active' : ''),
        role: 'tab',
        'aria-selected': S.subTab === def.id ? 'true' : 'false',
        onclick: function () { ctx.setSubTab(def.id); }
      }, [def.label]);
      if (def.n) btn.appendChild(h('span', { cls: 'tab-n' + (def.bad ? ' bad' : ''), text: String(def.n) }));
      tabs.appendChild(btn);
    });
    pane.appendChild(tabs);
    var body = h('div', { cls: 'sbody' });
    pane.appendChild(body);
    renderDetailBody(body, S.subTab);
  }

  function renderDetailBody(el, tab) {
    clear(el);
    var S = ctx.getState();
    if (!S.model) {
      if (S.loadingSession) { el.appendChild(skeleton()); return; }
      // 零会话来源（未部署宿主、纯靠 agent 写决策笔记）：别再让人"点左侧会话"
      if (S.index && !(S.index.sessions && S.index.sessions.length)) {
        el.appendChild(emptyState(['这个数据源没有会话记录。', '未部署追溯宿主（.agents/runner）时只有决策笔记——四个聚合模块照常使用，部署后这里按会话深看。'], { icon: 'clock' }));
        return;
      }
      el.appendChild(emptyState(['左侧点一个会话。', '四个聚合模块也在这里的范围内 —— 左轨勾选决定它们统计谁。'], { icon: 'clock' }));
      return;
    }
    if (tab === 'timeline') renderTimeline(el);
    else if (tab === 'diff') renderDiff(el);
    else if (tab === 'compliance') renderCompliance(el);
    else renderDenied(el);
  }

  /* ── 时间线 ─────────────────────────────────────────────────── */

  function summaryCards(m) {
    var sum = m.summary;
    var cells = [
      ['事件', sum.events, ''],
      ['回合', sum.turns, ''],
      ['耗时', TraceAnalyze.fmtDuration(sum.span), ''],
      ['协议错误', sum.protocolErrors, sum.protocolErrors ? 'bad' : 'ok'],
      ['合规未过', sum.compliance.byStatus.FAILED, sum.compliance.byStatus.FAILED ? 'bad' : 'ok'],
      ['被否决', m.denied.length, m.denied.length ? 'warn' : 'ok']
    ];
    var wrap = h('div', { cls: 'sum' });
    cells.forEach(function (c) {
      wrap.appendChild(h('div', { cls: 'sum-cell' }, [
        h('span', { cls: 'sum-label', text: c[0] }),
        h('span', { cls: 'sum-value ' + c[2], text: String(c[1]) })
      ]));
    });
    return wrap;
  }

  function kvBlock(session, m) {
    var lines = [
      ['会话', session.session_id],
      ['项目', session.project_path || '—'],
      ['规则', (session.rules_source || '—') + (session.rules_sha256_16 ? ' @ ' + session.rules_sha256_16 : '')],
      ['策略', (session.policy || '—') + ' · stopReason ' + (session.stop_reason || '—')],
      ['回合', String(m.summary.turns) + ' 个']
    ];
    var box = h('div', { cls: 'sum-kv' });
    lines.forEach(function (l) {
      box.appendChild(h('div', {}, [h('b', { text: l[0] + '：' }), l[1]]));
    });
    return box;
  }

  function eventTail(e) {
    if (e.compliance_check) {
      var st = e.compliance_check.status;
      return (TraceAnalyze.STATUS_LABEL[st] || st) + ' · ' + e.compliance_check.rule_id;
    }
    if (e.trace_normalized) return '报文内容 ' + e.trace_normalized.original_chars + ' 字符已截断记录（完整在快照）';
    if (e.payload && e.payload.method) return e.payload.method + (e.payload.approved === false ? ' · 被拒' : ' · 放行');
    if (e.payload && e.payload.path) return e.payload.path;
    if (e.payload && Array.isArray(e.payload.command)) return e.payload.command.join(' ');
    if (e.acp_message && e.acp_message.error) return '错误 ' + e.acp_message.error.code + ' ' + e.acp_message.error.message;
    var p = e.acp_message && e.acp_message.params;
    if (p) {
      var S = ctx.getState();
      if (p.path) return TraceAnalyze.shortPath(p.path, S.session && S.session.dir);
      if (p.content) return '[' + p.content.length + ' 字符]';
      if (p.update) return String(p.update.kind || 'update');
      if (p.options) return p.options.length + ' 个选项';
    }
    return '';
  }

  function evClass(e) {
    var cls = 'ev';
    if (e.compliance_check) cls += e.compliance_check.status === 'FAILED' ? ' bad' : ' mark';
    else if (e.kind === 'request') cls += ' req';
    else if (e.kind === 'response') cls += ' resp';
    else if (e.kind === 'notification') cls += ' note';
    else cls += ' mark';
    if (e.protocol && e.protocol.status === 'ERROR') cls += ' bad';
    return cls;
  }

  function eventRow(item) {
    var e = item.e;
    var S = ctx.getState();
    var row = h('div', { cls: evClass(e), style: { '--d': String(item.depth) } });
    // 锚点深链的目标行：@trace chip 点进来时带 pendingAnchorSeq，命中行加高亮类并展开原始报文
    var anchored = S.pendingAnchorSeq != null && e.seq === S.pendingAnchorSeq;
    if (anchored) {
      row.classList.add('ev-anchored');
      S.pendingAnchorSeq = null;
    }
    row.appendChild(h('span', { cls: 'ev-seq', text: '#' + e.seq }));
    var method = h('span', { cls: 'ev-method', text: TraceAnalyze.eventLabel(e), title: '点开看原始 JSON-RPC', tabindex: '0', role: 'button' });
    var json = null;
    // 原地开关：只造一次节点，避免整块重渲染把入场动画重播成"点一下闪一下"
    function toggle() {
      if (!json) {
        var payload = e.acp_message || { kind: e.kind, method: e.method, payload: e.payload, compliance_check: e.compliance_check };
        json = h('div', { cls: 'ev-json', text: JSON.stringify(payload, null, 1) });
        row.parentNode.insertBefore(json, row.nextSibling);
      } else {
        json.hidden = !json.hidden;
      }
    }
    method.addEventListener('click', toggle);
    onActivate(method, toggle);
    if (anchored) setTimeout(toggle, 0);   // 锚点行自动展开原始报文——深链进来就该看到证据本体
    row.appendChild(method);
    if (e.rpc_id != null) row.appendChild(h('span', { cls: 'chip chip-skip', text: 'id ' + e.rpc_id }));
    if (e.dir === 'internal') row.appendChild(h('span', { cls: 'chip chip-dir', text: '内部' }));
    if (e.trace_normalized) row.appendChild(h('span', { cls: 'chip chip-warn', text: '已截断' }));
    var tail = eventTail(e);
    if (tail) row.appendChild(h('span', { cls: 'ev-tail', text: tail }));
    return row;
  }

  function renderTimeline(pane) {
    var S = ctx.getState();
    var m = S.model;
    pane.appendChild(summaryCards(m));
    pane.appendChild(kvBlock(S.session, m));

    if (m.protocolErrors.length) {
      pane.appendChild(h('div', { cls: 'sec-title' }, ['协议错误', h('span', { cls: 'sec-n', text: m.protocolErrors.length + ' 条' })]));
      var rows = h('div', { cls: 'rows' });
      m.protocolErrors.forEach(function (p) {
        rows.appendChild(h('div', { cls: 'row bad' }, [
          h('div', { cls: 'row-top' }, [
            h('span', { cls: 'chip chip-bad', text: '#' + p.seq }),
            h('span', { cls: 'row-rule', text: p.method }),
            h('span', { cls: 'row-stat', text: String(p.code) })
          ]),
          h('div', { cls: 'row-msg', text: p.message }),
          p.hint ? h('div', { cls: 'row-src', text: '提示：' + p.hint }) : null
        ]));
      });
      pane.appendChild(rows);
    }

    pane.appendChild(h('div', { cls: 'sec-title' }, ['方法清单', h('span', { cls: 'sec-n', text: m.methods.length + ' 个' })]));
    var inv = h('div', { cls: 'rows' });
    m.methods.forEach(function (row) {
      inv.appendChild(h('div', { cls: 'row' + (row.hasError ? ' bad' : '') }, [
        h('div', { cls: 'row-top' }, [
          h('span', { cls: 'chip chip-dir', text: TraceAnalyze.DIR_LABEL[row.dir] || row.dir }),
          h('span', { cls: 'row-rule', text: row.method }),
          row.stability ? h('span', { cls: 'chip chip-skip', text: row.stability }) : null,
          h('span', { cls: 'row-stat', text: row.count + ' 次' })
        ]),
        row.badName ? h('div', { cls: 'row-src', text: '原设计文档里的名字：' + row.badName }) : null
      ]));
    });
    pane.appendChild(inv);

    pane.appendChild(h('div', { cls: 'sec-title' }, ['事件流', h('span', { cls: 'sec-n', text: m.summary.events + ' 条 · ' + m.summary.turns + ' 个回合' })]));

    m.turns.forEach(function (turn) {
      var box = h('div', { cls: 'turn' });
      box.appendChild(h('div', { cls: 'turn-head' }, [
        h('span', { cls: 'turn-seq', text: turn.isPreamble ? '会话级' : '#' + turn.key }),
        h('span', { text: turn.isPreamble ? turn.label : 'session/prompt' }),
        turn.promptKinds.length ? h('span', { cls: 'chip chip-dir', text: turn.promptKinds.join(' + ') }) : null,
        h('span', { cls: 'turn-note', text: turn.items.length + ' 条 · ' + TraceAnalyze.fmtDuration(turn.span) })
      ]));
      var body = h('div', { cls: 'turn-body' });
      turn.items.forEach(function (item) { body.appendChild(eventRow(item)); });
      box.appendChild(body);
      pane.appendChild(box);
    });

    // 锚点深链收尾：目标行滚进视野（此时 DOM 已挂好，requestAnimationFrame 后量位置才准）
    var anchored = pane.querySelector('.ev-anchored');
    if (anchored) requestAnimationFrame(function () { anchored.scrollIntoView({ block: 'center' }); });
  }

  /* ── 改动 ───────────────────────────────────────────────────── */

  function renderDiffBox(box, text) {
    clear(box);
    var pre = h('pre');
    TraceAnalyze.splitDiff(text).forEach(function (line) {
      pre.appendChild(h('span', { cls: line.cls, text: line.text + '\n' }));
    });
    box.appendChild(pre);
  }

  function renderDiff(pane) {
    var S = ctx.getState();
    var m = S.model;
    if (!m.writes.length && !m.commands.length) {
      pane.appendChild(emptyState(['这个会话没有落盘的改动，也没有执行命令。']));
      return;
    }

    pane.appendChild(h('div', { cls: 'sec-title' }, ['落盘改动', h('span', { cls: 'sec-n', text: m.writes.length + ' 处' })]));
    var wrap = h('div', { cls: 'rows' });
    if (!m.writes.length) wrap.appendChild(emptyState(['没有落盘的写盘。']));

    m.writes.forEach(function (w) {
      var row = h('div', { cls: 'row' });
      row.appendChild(h('div', { cls: 'row-top' }, [
        h('span', { cls: 'chip ' + (w.created ? 'chip-ok' : 'chip-warn'), text: w.created ? '新建' : '修改' }),
        h('span', { cls: 'row-path', text: TraceAnalyze.shortPath(w.path, S.session.dir) }),
        h('span', { cls: 'row-stat', text: w.beforeLines + ' → ' + w.afterLines + ' 行' })
      ]));
      if (w.normalized) {
        row.appendChild(h('div', { cls: 'row-src', text: '报文内容已截断记录（原 ' + w.normalized.original_chars + ' 字符），完整内容见快照' }));
      }

      var box = h('div', { cls: 'diffbox', hidden: true });
      var btnDiff = h('button', { cls: 'mini-btn', text: '展开 Diff' });
      var btnCopy = h('button', { cls: 'mini-btn', text: '复制路径' });
      btnDiff.addEventListener('click', async function () {
        if (box.hidden && !box.firstChild) {
          btnDiff.textContent = '读取中…';
          try {
            var text = w.diffName ? await ctx.loadDiff(S.reader, S.session, w.diffName) : '';
            renderDiffBox(box, text || '（这一处没有 diff 文件：宿主可能只记了状态没存 diff）');
          } catch (e) {
            renderDiffBox(box, '（读取 diff 失败：' + TraceSource.explain(e) + '）');
          }
          btnDiff.textContent = '收起 Diff';
          box.hidden = false;
        } else {
          box.hidden = !box.hidden;
          btnDiff.textContent = box.hidden ? '展开 Diff' : '收起 Diff';
        }
      });
      btnCopy.addEventListener('click', function () { ctx.copy(w.path, '路径已复制'); });
      row.appendChild(h('div', { cls: 'row-acts' }, [btnDiff, btnCopy]));
      row.appendChild(box);
      wrap.appendChild(row);
    });
    pane.appendChild(wrap);

    pane.appendChild(h('div', { cls: 'sec-title' }, ['已执行命令', h('span', { cls: 'sec-n', text: m.commands.length + ' 条' })]));
    var cwrap = h('div', { cls: 'rows' });
    if (!m.commands.length) cwrap.appendChild(emptyState(['没有执行过命令。']));
    m.commands.forEach(function (c) {
      cwrap.appendChild(h('div', { cls: 'row' }, [
        h('div', { cls: 'row-top' }, [
          h('span', { cls: 'chip chip-dir', text: '#' + c.seq }),
          h('span', { cls: 'row-path', text: c.command.join(' ') })
        ]),
        h('div', { cls: 'row-src', text: 'cwd: ' + (c.cwd || '—') + (c.pid ? ' · pid ' + c.pid : '') })
      ]));
    });
    pane.appendChild(cwrap);
  }

  /* ── 合规自检 ───────────────────────────────────────────────── */

  function renderCompliance(pane) {
    var S = ctx.getState();
    var m = S.model;
    if (!m.compliance.length) {
      pane.appendChild(emptyState([
        '这个会话没有产生合规检查结果。',
        '通常是这一轮没有发生写盘 —— 检查器是挂在写盘之后的。'
      ]));
      return;
    }

    var items = m.compliance.slice().sort(function (a, b) { return (TraceAnalyze.statusRank(a.status) - TraceAnalyze.statusRank(b.status)) || (a.seq - b.seq); });
    var st = m.summary.compliance.byStatus;

    pane.appendChild(h('div', { cls: 'sec-title' }, [
      '检查结果',
      h('span', { cls: 'sec-n', text: ['共 ' + items.length + ' 条'].concat(TraceAnalyze.statusHeadline(st)).join(' · ') })
    ]));

    var wrap = h('div', { cls: 'rows' });
    items.forEach(function (c) {
      var row = h('div', { cls: c.status === 'FAILED' || c.status === 'ERROR' ? 'row bad' : 'row' });
      row.appendChild(h('div', { cls: 'row-top' }, [
        h('span', { cls: 'chip ' + (TraceAnalyze.STATUS_CLASS[c.status] || 'chip-skip'), text: TraceAnalyze.STATUS_LABEL[c.status] || c.status }),
        h('span', { cls: 'row-rule', text: c.rule_id }),
        h('span', { cls: 'row-stat', text: '#' + c.seq })
      ]));
      row.appendChild(h('div', { cls: 'row-msg', text: c.message }));
      if (c.target) row.appendChild(h('div', { cls: 'row-src', text: '对象：' + TraceAnalyze.shortPath(c.target, S.session.dir) }));
      row.appendChild(h('div', { cls: 'row-src', text: '依据：' + (c.rule_source || '未标注') }));
      if (c.details && c.details.git_tracked != null) {
        row.appendChild(h('div', { cls: 'row-src', text: 'git 追踪 ' + c.details.git_tracked + ' − 1 = ' + c.details.minus_signature_self + ' · 清单 ' + c.details.manifest_entries + ' 条' }));
      }
      if (c.details && c.details.total_lines != null) {
        row.appendChild(h('div', { cls: 'row-src', text: '总行数 ' + c.details.total_lines + ' / 上限 ' + c.details.html_line_limit + ' · 内联块 ' + JSON.stringify(c.details.inline_blocks) }));
      }
      if (c.details && c.details.missing) {
        row.appendChild(h('div', { cls: 'row-src', text: '缺失标记：' + c.details.missing.join(', ') }));
      }
      if (c.details && c.details.files != null && c.details.anchors != null) {
        row.appendChild(h('div', {
          cls: 'row-src',
          text: `扫描 ${c.details.files} 个文件 · 通过 ${c.details.resolved} · 跳过 ${c.details.skipped} · 失效 ${c.details.failures.length}`,
        }));
        (c.details.failures || []).slice(0, 3).forEach(function (f) {
          row.appendChild(h('div', { cls: 'row-src', text: `失效：${f.file}:${f.line} ${f.raw} → ${f.reason}` }));
        });
      }
      if (c.details && c.details.output) {
        row.appendChild(h('div', { cls: 'ev-json', text: String(c.details.output).slice(0, 2000) }));
      }
      wrap.appendChild(row);
    });
    pane.appendChild(wrap);

    pane.appendChild(h('div', { cls: 'sec-title' }, ['本条 trace 用到的检查器', h('span', { cls: 'sec-n', text: m.rules.length + ' 个' })]));
    var rwrap = h('div', { cls: 'rows' });
    m.rules.forEach(function (r) {
      rwrap.appendChild(h('div', { cls: 'row' }, [
        h('div', { cls: 'row-top' }, [
          h('span', { cls: 'row-rule', text: r.rule_id }),
          r.failed ? h('span', { cls: 'chip chip-bad', text: '未通过 ' + r.failed }) : h('span', { cls: 'chip chip-ok', text: '全过' }),
          h('span', { cls: 'row-stat', text: r.count + ' 次' })
        ]),
        h('div', { cls: 'row-src', text: '依据：' + (r.rule_source || '未标注') })
      ]));
    });
    pane.appendChild(rwrap);
  }

  /* ── 被否决 ─────────────────────────────────────────────────── */

  function renderDenied(pane) {
    var S = ctx.getState();
    var m = S.model;
    if (!m.denied.length) {
      pane.appendChild(emptyState([
        '这个会话没有被否决的操作。',
        '这一屏专门收被拒的审批与被拦下的写盘/命令 —— 一条 trace 里最值钱的往往是「想过但没做」的部分。'
      ]));
      return;
    }
    pane.appendChild(h('div', { cls: 'sec-title' }, ['被否决 / 被拦下', h('span', { cls: 'sec-n', text: m.denied.length + ' 条' })]));
    var wrap = h('div', { cls: 'rows' });
    m.denied.forEach(function (d) {
      var row = h('div', { cls: 'row warn' });
      row.appendChild(h('div', { cls: 'row-top' }, [
        h('span', { cls: 'chip chip-warn', text: d.kind === 'permission' ? '审批被拒' : '执行被拦' }),
        h('span', { cls: 'row-rule', text: d.method || '(未知方法)' }),
        d.risk ? h('span', { cls: 'chip chip-dir', text: d.risk }) : null,
        h('span', { cls: 'row-stat', text: '#' + d.seq })
      ]));
      if (d.target) row.appendChild(h('div', { cls: 'row-msg', text: '目标：' + TraceAnalyze.shortPath(d.target, S.session.dir) }));
      if (d.reason) row.appendChild(h('div', { cls: 'row-src', text: d.reason }));
      if (d.decidedBy) row.appendChild(h('div', { cls: 'row-src', text: '由 ' + d.decidedBy + ' 决定' + (d.latency != null ? ' · 耗时 ' + d.latency + 'ms' : '') }));
      // 归组：同一件事的"审批被拒"与"随后的调用被拦"合成一条，并说明本来为什么会是两条
      if (d.alsoBlocked) {
        if (d.alsoBlocked.target) {
          row.appendChild(h('div', { cls: 'row-msg', text: '随后该调用被拦下：' + TraceAnalyze.shortPath(d.alsoBlocked.target, S.session.dir) }));
        }
        row.appendChild(h('div', { cls: 'row-src', text: '协议里 permission 请求与后续调用之间没有关联字段，底层留了两条记录（#' + d.seq + ' + #' + d.alsoBlocked.seq + '）；看板按「同回合 + 同方法」归成一条，这里不重复打扰。' }));
      }
      wrap.appendChild(row);
    });
    pane.appendChild(wrap);
  }

  return {
    configure: configure,
    $: $,
    h: h,
    clear: clear,
    onActivate: onActivate,
    emptyState: emptyState,
    skeleton: skeleton,
    kpiRow: kpiRow,
    toast: toast,
    setStatus: setStatus,
    renderRail: renderRail,
    renderSessionShell: renderSessionShell,
    renderDetailBody: renderDetailBody,
    splitDiff: function (t) { return TraceAnalyze.splitDiff(t); }
  };
})();

globalThis.TraceRender = TraceRender;
