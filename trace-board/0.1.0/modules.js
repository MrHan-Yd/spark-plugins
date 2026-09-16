/* 模块层：四个项目级 / 全库级视图。
 * 数据两路：决策笔记（index.notes，宿主构建期算好血缘）+ 会话 digest（宿主算好的摘要）。
 * 有笔记时四个模块以笔记为主、运行时事实为辅；没有笔记回落到纯 trace 视图。
 * 筛选状态存在 app 的 state 里，切模块来回不丢。
 */
var TraceModules = (function () {
  'use strict';

  var ctx = {
    getState: function () { return {}; },
    openSession: function () {},
  };

  function configure(next) {
    Object.keys(next || {}).forEach(function (k) { ctx[k] = next[k]; });
  }

  var h = TraceRender.h;
  var clear = TraceRender.clear;
  var emptyState = TraceRender.emptyState;
  // 旧版 render.js 被宿主缓存时没有 onActivate，兜底成仅鼠标可点，别让三个聚合视图直接抛错
  var onActivate = TraceRender.onActivate || function () {};

  /* 挂 click + 键盘激活后落进容器（chamber 条目/时间线卡都用） */
  function mount(parent, node, open) {
    node.addEventListener('click', open);
    onActivate(node, open);
    parent.appendChild(node);
    return node;
  }

  function pills(options, current, onPick, title) {
    var wrap = h('span', { cls: 'pills', title: title || null });
    options.forEach(function (o) {
      wrap.appendChild(h('button', {
        cls: 'pill' + (o === current ? ' on' : ''),
        text: o,
        onclick: function () { onPick(o); },
      }));
    });
    return wrap;
  }

  function criteria(kids) {
    return h('div', { cls: 'criteria' }, kids);
  }

  function sectionTitle(text, note) {
    return h('div', { cls: 'sec-title' }, [
      text,
      note ? h('span', { cls: 'sec-n', text: note }) : null,
    ]);
  }

  function capList(cap) {
    var out = [];
    (function walk(o, prefix) {
      if (!o || typeof o !== 'object') return;
      Object.keys(o).forEach(function (k) {
        var v = o[k];
        var key = prefix ? prefix + '.' + k : k;
        if (v === true) out.push(key);
        else if (v && typeof v === 'object') walk(v, key);
      });
    })(cap, '');
    return out;
  }

  function capChips(cap) {
    var wrap = h('span', { cls: 'capchips' });
    var items = capList(cap);
    (items.length ? items : ['(未记录)']).forEach(function (t) {
      wrap.appendChild(h('span', { cls: 'chip chip-dir', text: t }));
    });
    return wrap;
  }

  /* ── 笔记渲染小件 ───────────────────────────────────────────── */

  /** 笔记卡片的描述：优先「决策」节，其次「背景」，最后正文去标题行截 160 字 */
  function noteExcerpt(note) {
    var sec = TraceAggregate.noteSection(note, '决策') || TraceAggregate.noteSection(note, '背景');
    var text = String(sec || note.body || '').replace(/^#.*$/gm, '').trim();
    return text.slice(0, 160);
  }

  function noteStatusChip(note) {
    var label = TraceAggregate.NOTE_STATUS_LABEL[note.status] || note.status;
    return h('span', { cls: 'chip ' + (TraceAggregate.NOTE_STATUS_CLASS[note.status] || 'chip-skip'), text: label });
  }

  function catTag(category) {
    return h('span', { cls: 'cat-tag cat-' + category, text: TraceAggregate.NOTE_CLASS_LABEL[category] || category });
  }

  var NOTE_DOT = { 'chip-ok': 'ok', 'chip-warn': 'amber', 'chip-bad': 'red', 'chip-skip': 'gray' };

  /** 笔记卡片：分类徽章 + 被引用徽章 + 标题 + 摘要 + 日期/锚点脚注；状态用右上角色点。点击进详情抽屉 */
  function noteCard(note) {
    var open = function () { ctx.openNote(note); };
    var card = h('div', { cls: 'note-card dot-' + (NOTE_DOT[TraceAggregate.NOTE_STATUS_CLASS[note.status]] || 'gray'), tabindex: '0', role: 'button' }, [
      h('div', { cls: 'note-tags' }, [
        catTag(note.category),
        note.refd_by && note.refd_by.length ? h('span', { cls: 'ref-badge', text: '被引用 ×' + note.refd_by.length }) : null,
      ]),
      h('div', { cls: 'note-title', text: note.title }),
      h('div', { cls: 'note-desc', text: noteExcerpt(note) }),
      h('div', { cls: 'note-meta' }, [
        h('span', { text: note.date || '—' }),
        h('span', { cls: 'note-id', text: '#' + note.id }),
      ]),
    ]);
    card.addEventListener('click', open);
    onActivate(card, open);
    return card;
  }

  function staleNote(pane, agg) {
    if (!agg.stale || !agg.stale.length) return;
    pane.appendChild(h('div', { cls: 'criteria' }, [
      h('span', { cls: 'chip chip-warn', text: '索引缺摘要' }),
      h('span', { cls: 'crit-text', text: '这些会话来自旧版宿主生成的索引，聚合模块看不到它们：' + agg.stale.join(', ') }),
      h('span', { cls: 'crit-tail' }, [
        h('span', { cls: 'src-or', text: '重建索引：' }),
        h('code', { text: 'node .agents/runner/trace-index.mjs' }),
      ]),
    ]));
  }

  /** 分节白卡（参考站式）：标题行收进卡内，内容网格铺在卡里，不再裸漂在网格底纹上 */
  function secPanel(title, note, body) {
    return h('div', { cls: 'sec-panel' }, [
      h('div', { cls: 'sec-panel-head' }, [
        h('b', { text: title }),
        note ? h('span', { cls: 'sec-panel-note', text: note }) : null,
      ]),
      body,
    ]);
  }

  /* ── 架构基线 ───────────────────────────────────────────────── */

  function renderBaseline(pane, sessions) {
    var S = ctx.getState();
    var agg = TraceAggregate.baseline(sessions);
    var notes = TraceAggregate.noteList(S.index);
    var model = notes.length ? TraceAggregate.notesModel(notes, S.query) : null;

    /* KPI：有笔记用笔记四态（副行给运行时事实），没有用会话事实四卡 */
    if (model) {
      var deniedTotal = sessions.reduce(function (n, s) {
        var c = s.counts || {};
        return n + Math.max(0, (c.write_attempts || 0) - (c.write_applied || 0));
      }, 0);
      var compFailed = sessions.reduce(function (n, s) { return n + ((s.errors || {}).compliance_failed || 0); }, 0);
      pane.appendChild(TraceRender.kpiRow([
        ['已落地', model.byStatus.implemented, 'kpi-green', '运行时落盘 ' + agg.totals.writes + ' 次'],
        ['待评审', model.byStatus.proposed, 'kpi-blue', '纳入会话 ' + agg.sessions + ' 个'],
        ['避坑否决', model.byStatus.rejected, 'kpi-red', '运行时被拦 ' + deniedTotal + ' 次'],
        ['归档', model.byStatus.archived, 'kpi-amber', '合规未过 ' + compFailed + ' 条'],
      ]));
    } else {
      pane.appendChild(TraceRender.kpiRow([
        ['纳入会话', agg.sessions, 'kpi-blue', '统计范围'],
        ['涉及文件', agg.totals.files, '', '写盘涉及面'],
        ['落盘次数', agg.totals.writes, 'kpi-green', '现在生效的改动'],
        ['生效检查器', agg.rules.length, 'kpi-amber', agg.rules.length ? '挂载的合规规则' : '未产生合规结果'],
      ]));
    }
    staleNote(pane, agg);

    if (model) {
      var wallBody;
      if (!model.heavy.length) {
        wallBody = emptyState(['还没有笔记互相引用。', '在笔记正文里用相对链接引用别的笔记（文件名即可），这里就会长出承重墙。']);
      } else {
        wallBody = h('div', { cls: 'card-grid' });
        model.heavy.slice(0, 9).forEach(function (note) { wallBody.appendChild(noteCard(note)); });
      }
      pane.appendChild(secPanel('系统承重墙', '被其它笔记引用最多的决策 —— 引用数按篇去重，构建期统计', wallBody));

      var chamberBody;
      if (!model.cats.length) {
        chamberBody = emptyState(['这个筛选条件下没有笔记。']);
      } else {
        chamberBody = h('div', { cls: 'chamber-grid' });
        model.cats.forEach(function (c) {
          var list = h('div', { cls: 'chamber-list' });
          c.items.forEach(function (note) {
            var open = function () { ctx.openNote(note); };
            mount(list, h('div', { cls: 'chamber-item', tabindex: '0', role: 'button' }, [
              h('div', { cls: 'note-title', text: note.title }),
              h('div', { cls: 'note-meta' }, [
                h('span', { text: note.date || '—' }),
                note.refd_by.length ? h('span', { cls: 'ref-badge', text: '↗ ' + note.refd_by.length }) : null,
              ]),
            ]), open);
          });
          chamberBody.appendChild(h('div', { cls: 'chamber' }, [
            h('div', { cls: 'chamber-head' }, [
              h('b', { cls: 'chamber-name', text: TraceAggregate.NOTE_CLASS_LABEL[c.category] || c.category }),
              h('span', { cls: 'chamber-count', text: c.items.length + ' 篇' }),
            ]),
            list,
          ]));
        });
      }
      pane.appendChild(secPanel('领域架构分类阵列', '按分类铺开的决策知识：哪里沉淀得多，一眼能看出来', chamberBody));
    } else {
      var heavyBody;
      if (!agg.heavy.length) {
        heavyBody = emptyState(['这段范围里没有落盘的改动。']);
      } else {
        heavyBody = h('div');
        var max = agg.heavy[0].writes || 1;
        var box = h('div', { cls: 'heavy' });
        agg.heavy.slice(0, 20).forEach(function (file) {
          var pct = Math.max(4, Math.round((file.writes / max) * 100));
          box.appendChild(h('div', { cls: 'heavy-row', title: file.path }, [
            h('span', { cls: 'heavy-path', text: file.rel || TraceAggregate.targetLabel(file.path) }),
            h('span', { cls: 'bar' }, [h('span', { style: { width: pct + '%' } })]),
            h('span', { cls: 'heavy-num', text: file.sessions + ' 会话' }),
            h('span', { cls: 'heavy-num', text: file.writes + ' 次' }),
          ]));
        });
        heavyBody.appendChild(box);
        if (agg.heavy.length > 20) {
          heavyBody.appendChild(h('div', { cls: 'src-hint', text: '只显示前 20 个（共 ' + agg.heavy.length + ' 个）' }));
        }
      }
      pane.appendChild(secPanel('系统承重墙',
        '排序依据：先看被多少个会话改过，再看改动次数 —— 两个原始量都列出来，不发明加权公式', heavyBody));

      var catBody;
      if (!agg.categories.length) {
        catBody = emptyState(['没有可归类的目录。']);
      } else {
        catBody = h('div', { cls: 'catgrid' });
        agg.categories.forEach(function (c) {
          catBody.appendChild(h('div', { cls: 'catcard', title: c.dir }, [
            h('div', { cls: 'cat-name', text: c.dir }),
            h('div', { cls: 'cat-num', text: c.files + ' 个文件 · ' + c.writes + ' 次改动 · ' + c.sessions + ' 个会话' }),
          ]));
        });
      }
      pane.appendChild(secPanel('领域架构分类阵列', '现行生效的改动面按目录铺开：哪里被碰得多，一眼能看出来', catBody));
    }

    /* 现行生效的规则与能力（笔记与 trace 两个世界共用） */
    var ruleBody = h('div');
    var kv = h('div', { cls: 'sum-kv' });
    kv.appendChild(h('div', {}, [h('b', { text: 'ACP 协议版本：' }), String(agg.caps.protocol_version ?? '—')]));
    var ai = agg.caps.agent_info || {};
    kv.appendChild(h('div', {}, [
      h('b', { text: 'agent：' }),
      ai.name ? ai.name + (ai.version ? ' ' + ai.version : '') : '—',
    ]));
    kv.appendChild(h('div', {}, [h('b', { text: 'agent 声明能力：' }), capChips(agg.caps.agent)]));
    kv.appendChild(h('div', {}, [h('b', { text: '宿主声明给 agent 的能力：' }), capChips(agg.caps.client)]));
    agg.fingerprints.forEach(function (f) {
      kv.appendChild(h('div', {}, [h('b', { text: '规则指纹：' }), f.source + ' @ ' + f.sha + '（' + f.sessions + ' 个会话）']));
    });
    ruleBody.appendChild(kv);

    var rwrap = h('div', { cls: 'rows' });
    if (!agg.rules.length) rwrap.appendChild(emptyState(['这段范围里没有产生合规检查结果 —— 通常是没发生写盘。']));
    agg.rules.forEach(function (r) {
      rwrap.appendChild(h('div', { cls: 'row' + (r.failed ? ' bad' : '') }, [
        h('div', { cls: 'row-top' }, [
          h('span', { cls: 'row-rule', text: r.rule_id }),
          r.failed ? h('span', { cls: 'chip chip-bad', text: '未通过 ' + r.failed }) : h('span', { cls: 'chip chip-ok', text: '全过' }),
          h('span', { cls: 'chip chip-skip', text: '共 ' + r.total + ' 次' }),
          h('span', { cls: 'row-stat', text: r.sessions + ' 个会话' }),
        ]),
        h('div', { cls: 'row-src', text: '依据：' + (r.rule_source || '未标注') }),
        h('div', { cls: 'row-src', text: '通过 ' + r.passed + ' · 未通过 ' + r.failed + ' · 不适用 ' + r.skipped + (r.error ? ' · 出错 ' + r.error : '') }),
      ]));
    });
    ruleBody.appendChild(rwrap);
    pane.appendChild(secPanel('现行生效的规则与能力',
      '规则指纹 + 挂载的检查器 + 协商出的 agent 能力', ruleBody));
  }

  /* ── 演进时间线 ─────────────────────────────────────────────── */

  /** 卡内日期药丸（参考站式）：笔记挂日历图标 + 完整日期，会话挂时钟图标 +「日 时:分:秒」 */
  function whenPill(text, icon) {
    return h('span', { cls: 'tl-when' }, [
      h('span', { cls: 'ic ic-' + icon, 'aria-hidden': 'true' }),
      h('span', { text: text }),
    ]);
  }

  /** 参考站式轨道时间线：组头按月（YYYY-MM · N 条），具体日期沉进每张卡的药丸，
   *  左轨每个条目一枚节点圆环。笔记（按日）与会话（按日）合并到同一条轨道：决策与执行对照回看。
   *  @see [SPEC §7.3 模块信息架构](../../.agents/runner/SPEC.md#73-模块信息架构v3决策笔记驱动无笔记回落-trace-视图)
   */
  function renderEvolution(pane, sessions) {
    var S = ctx.getState();
    var notes = TraceAggregate.noteList(S.index);
    var f = S.evo || { month: '全部', kind: '全部' };
    var kinds = ['全部', '决策笔记', '会话执行'];

    var noteDays = notes.length ? TraceAggregate.notesModel(notes, S.query).days : [];
    var sessGroups = TraceAggregate.evolution(sessions, null);

    var months = {};
    noteDays.forEach(function (g) { months[g.date.slice(0, 7)] = 1; });
    sessGroups.forEach(function (g) { months[g.date.slice(0, 7)] = 1; });
    var monthList = Object.keys(months).sort().reverse();

    function criteriaRow() {
      return criteria([
        h('span', { cls: 'crit-label', text: '月份切片:' }),
        pills(['全部'].concat(monthList), f.month, function (v) { ctx.setEvo({ month: v }); }),
        h('span', { cls: 'crit-label', text: '类型切片:' }),
        pills(kinds, f.kind, function (v) { ctx.setEvo({ kind: v }); }),
        h('span', { cls: 'crit-tail' }, [
          h('button', { cls: 'mini-btn', text: '重置时间线筛选', onclick: function () { ctx.setEvo({ month: '全部', kind: '全部' }); } }),
        ]),
      ]);
    }

    /* 月组桶：组头只报月份与条数，日期细节全部下沉到卡片药丸（对齐参考站） */
    var byMonth = {};
    function push(date, key, value) {
      var mk = date.slice(0, 7);
      var m = byMonth[mk] || (byMonth[mk] = { count: 0, days: {} });
      (m.days[date] = m.days[date] || []).push({ kind: key, value: value });
      m.count++;
    }
    if (f.kind !== '会话执行') {
      noteDays.forEach(function (g) {
        if (f.month !== '全部' && g.date.slice(0, 7) !== f.month) return;
        g.items.forEach(function (note) { push(g.date, 'notes', note); });
      });
    }
    if (f.kind !== '决策笔记') {
      sessGroups.forEach(function (g) {
        if (f.month !== '全部' && g.date.slice(0, 7) !== f.month) return;
        g.items.forEach(function (it) { push(g.date, 'sessions', it); });
      });
    }

    var monthKeys = Object.keys(byMonth).sort().reverse();
    var total = 0;
    monthKeys.forEach(function (mk) { total += byMonth[mk].count; });

    pane.appendChild(criteriaRow());

    if (!total) {
      pane.appendChild(emptyState(['这个切片下没有决策或会话。', '换个月份或类型，或把左轨的统计范围放宽。']));
      return;
    }

    var tl = h('div', { cls: 'tl' });
    monthKeys.forEach(function (mk) {
      var m = byMonth[mk];
      var group = h('div', { cls: 'tl-group' }, [h('span', { cls: 'tl-dot' })]);
      group.appendChild(h('div', { cls: 'tl-date' }, [mk, h('span', { cls: 'sec-n', text: m.count + ' 条' })]));
      var items = h('div', { cls: 'tl-items' });

      Object.keys(m.days).sort(function (a, b) { return a < b ? 1 : -1; }).forEach(function (date) {
        m.days[date].forEach(function (entry) {
          if (entry.kind === 'notes') {
            var note = entry.value;
            mount(items, h('div', { cls: 'tl-item', tabindex: '0', role: 'button' }, [
              h('div', { cls: 'tl-top' }, [
                whenPill(note.date || '—', 'cal'),
                catTag(note.category),
                noteStatusChip(note),
                h('span', { cls: 'tl-title', text: note.title }),
              ]),
              h('div', { cls: 'tl-sub', text: noteExcerpt(note) }),
            ]), function () { ctx.openNote(note); });
          } else {
            var it = entry.value;
            var flags = h('span', { cls: 'sess-flags' });
            if (it.protoErrors) flags.appendChild(h('span', { cls: 'chip chip-bad', text: '协议错 ' + it.protoErrors }));
            if (it.compFailed) flags.appendChild(h('span', { cls: 'chip chip-bad', text: '合规未过 ' + it.compFailed }));
            if (it.denied) flags.appendChild(h('span', { cls: 'chip chip-warn', text: '被拦 ' + it.denied }));
            if (!flags.childNodes.length) flags.appendChild(h('span', { cls: 'chip chip-ok', text: '干净' }));
            mount(items, h('div', {
              cls: 'tl-item',
              tabindex: '0',
              role: 'button',
              title: '点开这个会话的详情',
            }, [
              h('div', { cls: 'tl-top' }, [
                whenPill(date.slice(5) + ' ' + it.time, 'clock'),
                h('span', { cls: 'tl-title', text: '会话 ' + it.short }),
                flags,
              ]),
              h('div', { cls: 'tl-sub', text: '策略 ' + it.policy + ' · stopReason ' + it.stopReason + ' · ' + it.events + ' 事件 · 落盘 ' + it.writes + '/' + it.attempts }),
            ]), function () { ctx.openSession(it.session); });
          }
        });
      });

      group.appendChild(items);
      tl.appendChild(group);
    });
    pane.appendChild(tl);
  }

  /* ── 文件档案 ─────────────────────────────────────────────────
   * 回答「这个文件为什么变成现在这样」：一个文件一行档案——谁改过、被拦过、合规挂没挂过。
   * 点击展开该文件的全部运行事实（写盘 / 被拦 / 合规未过），行内点会话号跳会话详情。 */

  function renderArchive(pane, sessions) {
    var S = ctx.getState();
    var files = TraceAggregate.fileArchive(sessions);
    var flagged = files.filter(function (f) { return f.deniedCount + f.compFailed > 0; }).length;

    pane.appendChild(criteria([
      h('span', { cls: 'crit-label', text: '涉及文件 ' + files.length + ' 个' }),
      h('span', { cls: 'crit-tail' }, [
        h('span', { cls: 'src-or', text: flagged ? flagged + ' 个文件有被拦或合规未过的记录' : '没有被拦或合规未过的文件' }),
      ]),
    ]));

    if (!files.length) {
      pane.appendChild(emptyState([
        '这段范围里没有落盘的改动。',
        '文件档案按 digest 聚合：宿主跑的会话里有写盘 / 被拦 / 合规结果，这里就会有。',
      ]));
      return;
    }

    var wrap = h('div', { cls: 'rows' });
    files.slice(0, 60).forEach(function (f) {
      var row = h('div', { cls: 'row' + (f.deniedCount + f.compFailed ? ' warn' : '') });
      row.appendChild(h('div', { cls: 'row-top' }, [
        h('span', { cls: 'row-path', text: f.rel }),
        h('span', { cls: 'row-stat', text: f.writeSessions + ' 会话 · ' + f.writeCount + ' 次落盘' }),
      ]));
      var acts = h('div', { cls: 'row-acts' });
      if (f.deniedCount) acts.appendChild(h('span', { cls: 'chip chip-warn', text: '被拦 ' + f.deniedCount }));
      if (f.compFailed) acts.appendChild(h('span', { cls: 'chip chip-bad', text: '合规 ' + f.compFailed }));
      if (!acts.childNodes.length) acts.appendChild(h('span', { cls: 'chip chip-ok', text: '干净' }));

      var open = function () {
        var expanded = row.dataset.open === '1';
        row.dataset.open = expanded ? '' : '1';
        detail.hidden = expanded;
        btnDetail.textContent = expanded ? '展开档案' : '收起档案';
      };
      var btnDetail = h('button', { cls: 'mini-btn', text: '展开档案' });
      btnDetail.addEventListener('click', open);
      acts.appendChild(btnDetail);
      row.appendChild(acts);

      var detail = h('div', { cls: 'arch-detail', hidden: true });
      function detailRows(title, items, render) {
        if (!items.length) return;
        detail.appendChild(h('div', { cls: 'row-src arch-sec', text: title + ' ' + items.length + ' 条' }));
        items.forEach(function (x) { detail.appendChild(render(x)); });
      }
      detailRows('落盘', f.writes, function (w) {
        var s = w.session;
        return mount(h('div', { cls: 'arch-line', tabindex: '0', role: 'button', title: '点开会话详情' }, [
          h('span', { cls: 'chip chip-dir', text: TraceAggregate.short(s.session_id) }),
          h('span', { text: TraceAggregate.dayOf(s.started_at).slice(5) + ' · ' + w.writes + ' 次落盘' }),
        ]), function () { ctx.openSession(s); });
      });
      detailRows('被拦 / 被拒', f.denied, function (x) {
        return mount(h('div', { cls: 'arch-line', tabindex: '0', role: 'button', title: '点开会话详情' }, [
          h('span', { cls: 'chip chip-warn', text: x.kind === 'permission' ? '审批被拒' : '执行被拦' }),
          h('span', { cls: 'chip chip-dir', text: TraceAggregate.short(x.session.session_id) + '#' + x.seq }),
          h('span', { text: (x.method || '未知方法') + (x.decidedBy ? ' · 由 ' + x.decidedBy + ' 决定' : '') }),
        ]), function () { ctx.openSession(x.session); });
      });
      detailRows('合规未过', f.compliance, function (x) {
        return mount(h('div', { cls: 'arch-line', tabindex: '0', role: 'button', title: '点开会话详情' }, [
          h('span', { cls: 'chip chip-bad', text: x.ruleId }),
          h('span', { cls: 'chip chip-dir', text: TraceAggregate.short(x.session.session_id) + '#' + x.seq }),
          h('span', { text: x.message }),
        ]), function () { ctx.openSession(x.session); });
      });
      row.appendChild(detail);
      wrap.appendChild(row);
    });
    pane.appendChild(wrap);
    if (files.length > 60) {
      pane.appendChild(h('div', { cls: 'src-hint', text: '只显示前 60 个（共 ' + files.length + ' 个）。' }));
    }
    pane.appendChild(h('div', { cls: 'src-hint', text: '排序：有被拦/合规未过的在前，再按落盘次数。展开后每条都能点回所在会话。' }));
  }

  /* ── 避坑智库 ───────────────────────────────────────────────── */

  var SORTS = [{ id: 'newest', label: '最新优先' }, { id: 'oldest', label: '最早优先' }, { id: 'refs', label: '引用最多' }];

  /**
   * 避坑智库：被否决的决策笔记（三块卡：❌ 放弃备选 / 💡 权衡依据 / ✅ 采纳结果）
   * + 运行时被拦/未通过的条目（表格）。
   * 「引用」列的口径要说清楚：**同一个目标文件或同一条规则在多少个会话里被拦过**。
   * - 按**会话**去重而不是按行数 —— 同一件事在上游留两条记录（permission + blocked）是常态；
   * - 审批被拒那条记录本身不带目标，得顺着它的 parent 解出 path/command。
   *
   * @see [SPEC §7.3 四个区块](../../.agents/runner/SPEC.md#73-四个区块修正-v1-的编号与信息架构)
   */
  function renderPitfalls(pane, sessions) {
    var S = ctx.getState();
    var notes = TraceAggregate.noteList(S.index);
    var f = S.pit || { status: '全部', category: '全部', sort: 'newest' };
    var res = TraceAggregate.pitfalls(sessions, f);

    var sortPills = h('span', { cls: 'pills' });
    SORTS.forEach(function (s) {
      sortPills.appendChild(h('button', {
        cls: 'pill' + (s.id === f.sort ? ' on' : ''),
        text: s.label,
        onclick: function () { ctx.setPit({ sort: s.id }); },
      }));
    });

    pane.appendChild(criteria([
      h('span', { cls: 'crit-label', text: '状态:' }),
      pills(['全部'].concat(res.options.statuses), f.status, function (v) { ctx.setPit({ status: v }); }),
      h('span', { cls: 'crit-label', text: '分类:' }),
      pills(['全部'].concat(res.options.categories), f.category, function (v) { ctx.setPit({ category: v }); }),
      sortPills,
      h('span', { cls: 'crit-tail' }, [
        h('span', { cls: 'src-or', text: '重复踩坑 ' + res.repeated + ' 条' }),
        h('button', { cls: 'mini-btn', text: '重置筛选', onclick: function () { ctx.resetPit(); } }),
      ]),
    ]));

    /* 被否决的决策笔记：写作纪律就是「先写它最强的理由，再写为什么仍然不用」 */
    var rejected = notes.filter(function (note) { return note.status === 'rejected'; })
      .filter(function (note) { return hitQuery(note, S.query); });
    if (rejected.length) {
      pane.appendChild(sectionTitle('被否决的决策', rejected.length + ' 篇 rejected 笔记'));
      var grid = h('div', { cls: 'card-grid' });
      rejected.forEach(function (note) {
        var open = function () { ctx.openNote(note); };
        var card = h('div', { cls: 'pit-card', tabindex: '0', role: 'button' }, [
          h('div', { cls: 'note-tags' }, [catTag(note.category), h('span', { cls: 'note-id', text: '#' + note.id })]),
          h('div', { cls: 'note-title', text: note.title }),
          pitBlock('pit-abandon', '❌ 放弃备选', TraceAggregate.noteSection(note, '放弃方案') || '（未写放弃方案一节）'),
          pitBlock('pit-basis', '💡 权衡依据', TraceAggregate.noteSection(note, '背景') || '（未写背景一节）'),
          pitBlock('pit-adopt', '✅ 采纳结果', TraceAggregate.noteSection(note, '决策') || '（未写决策一节）'),
        ]);
        card.addEventListener('click', open);
        onActivate(card, open);
        grid.appendChild(card);
      });
      pane.appendChild(grid);
    }

    if (!res.rows.length && !rejected.length) {
      pane.appendChild(emptyState([
        res.all ? '这个筛选条件下没有条目。' : '这段范围里没有被否决或被拦下的记录。',
        res.all ? '换个状态或分类试试。' : '避坑智库专门收被否决的笔记、被拦下的写盘/命令，以及合规未通过。',
      ]));
      return;
    }
    if (!res.rows.length) return;

    pane.appendChild(sectionTitle('运行时拦截', '被拒的审批、被拦下的写盘/命令与合规未通过'));
    var head = h('tr');
    [['编号', 'c-no'], ['分类', 'c-cat'], ['标题', 'c-title'], ['状态', 'c-st'], ['日期', 'c-date'], ['引用', 'c-ref']]
      .forEach(function (c) { head.appendChild(h('th', { cls: c[1], text: c[0] })); });

    var tbody = h('tbody');
    res.rows.forEach(function (r) {
      var open = function () { ctx.openSessionByDir(r.sessionDir); };
      var row = h('tr', { title: '点开所在会话', onclick: open, tabindex: '0' });
      row.appendChild(h('td', { cls: 'c-no', text: r.sessionShort + '#' + r.seq }));
      row.appendChild(h('td', { cls: 'c-cat' }, [h('span', { cls: 'chip chip-dir', text: r.category })]));
      row.appendChild(h('td', { cls: 'c-title', text: r.title }));
      row.appendChild(h('td', { cls: 'c-st' }, [
        h('span', { cls: 'chip ' + (r.status === '未通过' || r.status === '检查器出错' ? 'chip-bad' : 'chip-warn'), text: r.status }),
      ]));
      row.appendChild(h('td', { cls: 'c-date', text: TraceAggregate.dayOf(r.date).slice(5) }));
      row.appendChild(h('td', { cls: 'c-ref', text: String(r.refs) }));
      onActivate(row, open);
      tbody.appendChild(row);
    });

    pane.appendChild(h('div', { cls: 'tbl-wrap' }, [h('table', { cls: 'tbl' }, [h('thead', {}, [head]), tbody])]));
    pane.appendChild(h('div', {
      cls: 'src-hint',
      text: '「引用」= 同一个目标文件或同一条规则在多少个会话里被拦过，也就是这个坑被踩过几次；点任意一行跳回所在会话。',
    }));
  }

  function pitBlock(cls, label, text) {
    return h('div', { cls: 'pit-block ' + cls }, [
      h('b', { text: label }),
      h('p', { text: text || '—' }),
    ]);
  }

  function hitQuery(note, query) {
    var f = String(query || '').trim().toLowerCase();
    if (!f) return true;
    return (note.title + ' ' + note.id + ' ' + note.body).toLowerCase().indexOf(f) >= 0;
  }

  /* ── 决策清单 ───────────────────────────────────────────────── */

  function renderLedger(pane, sessions) {
    var S = ctx.getState();
    var notes = TraceAggregate.noteList(S.index);
    if (notes.length) renderNoteLedger(pane, notes);
    else renderSessionLedger(pane, sessions);
  }

  var NOTE_STATUS_KEYS = ['implemented', 'proposed', 'rejected', 'archived'];
  function statusLabelOf(key) { return TraceAggregate.NOTE_STATUS_LABEL[key] || key; }

  /** 全库决策笔记总表：编号 / 分类 / 标题 / 状态 / 日期 / 引用（六列，对齐参考站） */
  function renderNoteLedger(pane, notes) {
    var S = ctx.getState();
    var f = S.led || { severity: '全部' };
    var shown = notes.filter(function (n) { return hitQuery(n, S.query); })
      .filter(function (n) { return f.severity === '全部' || n.status === f.severity; });

    pane.appendChild(criteria([
      h('span', { cls: 'crit-label', text: '状态:' }),
      pills(['全部'].concat(NOTE_STATUS_KEYS).map(statusLabelOf), statusLabelOf(f.severity), function (label) {
        var key = NOTE_STATUS_KEYS.filter(function (k) { return statusLabelOf(k) === label; })[0] || '全部';
        ctx.setLed({ severity: key });
      }, 'implemented=已落地 · proposed=待评审 · rejected=被否决 · archived=归档'),
      h('span', { cls: 'crit-tail' }, [
        h('span', { cls: 'src-or', text: '共 ' + notes.length + ' 篇' }),
      ]),
    ]));

    if (!shown.length) {
      pane.appendChild(emptyState(['没有匹配的笔记。', '换个状态，或清一下顶栏的搜索词。']));
      return;
    }

    var head = h('tr');
    [['编号', 'c-no'], ['分类', 'c-cat'], ['标题', 'c-title'], ['状态', 'c-st'], ['日期', 'c-date'], ['引用', 'c-ref']]
      .forEach(function (c) { head.appendChild(h('th', { cls: c[1], text: c[0] })); });

    var tbody = h('tbody');
    shown.forEach(function (n, i) {
      var open = function () { ctx.openNote(n); };
      var row = h('tr', { title: '点开这篇笔记的详情', onclick: open, tabindex: '0' }, [
        h('td', { cls: 'c-no', text: 'N' + String(i + 1).padStart(3, '0') }),
        h('td', { cls: 'c-cat' }, [catTag(n.category)]),
        h('td', { cls: 'c-title', text: n.title }),
        h('td', { cls: 'c-st' }, [noteStatusChip(n)]),
        h('td', { cls: 'c-date', text: (n.date || '').slice(5) }),
        h('td', { cls: 'c-ref', text: String(n.refd_by.length) }),
      ]);
      onActivate(row, open);
      tbody.appendChild(row);
    });
    pane.appendChild(h('div', { cls: 'tbl-wrap' }, [h('table', { cls: 'tbl' }, [h('thead', {}, [head]), tbody])]));
    pane.appendChild(h('div', { cls: 'src-hint', text: '「引用」列 = 有多少篇笔记的正文链到本篇（按篇去重）。' }));
  }

  function renderSessionLedger(pane, sessions) {
    var S = ctx.getState();
    var f = S.led || { severity: '全部' };
    var rows = TraceAggregate.ledger(sessions);
    var sevs = ['全部', 'bad', 'warn', 'ok'];
    var shown = rows.filter(function (r) { return f.severity === '全部' || r.severity === f.severity; });

    pane.appendChild(criteria([
      h('span', { cls: 'crit-label', text: '状态:' }),
      pills(sevs, f.severity, function (v) { ctx.setLed({ severity: v }); },
        'bad=有未通过/协议错误 · warn=有被拦下 · ok=干净'),
      h('span', { cls: 'crit-tail' }, [
        h('span', { cls: 'src-or', text: '共 ' + rows.length + ' 个会话' }),
      ]),
    ]));

    if (!shown.length) {
      pane.appendChild(emptyState(['这段范围里没有会话。']));
      return;
    }

    var head = h('tr');
    [['编号', 'c-no'], ['分类', 'c-cat'], ['标题', 'c-title'], ['状态', 'c-st'], ['日期', 'c-date'], ['改动', 'c-ref']]
      .forEach(function (c) { head.appendChild(h('th', { cls: c[1], text: c[0] })); });

    var tbody = h('tbody');
    shown.forEach(function (r) {
      var open = function () { ctx.openSession(r.session); };
      var row = h('tr', {
        title: '点开这个会话的详情',
        onclick: open,
        tabindex: '0',
      }, [
        h('td', { cls: 'c-no', text: 'S' + String(r.no).padStart(2, '0') + ' ' + r.short }),
        h('td', { cls: 'c-cat' }, [h('span', { cls: 'chip chip-dir', text: r.category })]),
        h('td', { cls: 'c-title', text: r.title + ' · ' + r.events + ' 事件' }),
        h('td', { cls: 'c-st' }, [
          h('span', { cls: 'chip ' + (r.severity === 'bad' ? 'chip-bad' : r.severity === 'warn' ? 'chip-warn' : 'chip-ok'), text: r.status }),
        ]),
        h('td', { cls: 'c-date', text: TraceAggregate.dayOf(r.date).slice(5) }),
        h('td', { cls: 'c-ref', text: r.changes + '·' + r.denied }),
      ]);
      onActivate(row, open);
      tbody.appendChild(row);
    });
    pane.appendChild(h('div', { cls: 'tbl-wrap' }, [h('table', { cls: 'tbl' }, [h('thead', {}, [head]), tbody])]));
    pane.appendChild(h('div', { cls: 'src-hint', text: '「改动」列 = 落盘次数 · 被拦下次数。' }));
  }

  return {
    configure: configure,
    renderBaseline: renderBaseline,
    renderEvolution: renderEvolution,
    renderArchive: renderArchive,
    renderPitfalls: renderPitfalls,
    renderLedger: renderLedger,
  };
})();

globalThis.TraceModules = TraceModules;