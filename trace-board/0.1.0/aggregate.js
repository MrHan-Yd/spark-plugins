/* 聚合层：把「选中的这批会话」合成项目级 / 全库级的视图模型。
 *
 * 四个模块（架构基线 / 演进时间线 / 避坑智库 / 决策清单）都只依赖 session.digest ——
 * 那是宿主在 index.json 里一次算好的小摘要。所以这里不需要把每个会话的 events.jsonl 都拉下来，
 * HTTP 远程模式下也就不会变成 N+1 次请求。
 *
 * 索引里没有 digest（老版本宿主生成的）时，这里不假装有数据：返回空结果并带上 stale 标记，
 * 让界面直接告诉用户"用新版宿主重建索引"，而不是静默显示 0。
 */
var TraceAggregate = (function () {
  'use strict';

  function short(id) {
    var s = String(id || '');
    var m = s.match(/([0-9a-f]{6})$/i);
    return m ? m[1] : s.slice(-6);
  }

  function digestOf(s) {
    return s && s.digest && Array.isArray(s.digest.denied) ? s.digest : null;
  }

  /** 有会话缺 digest 时返回它们，供界面提示 */
  function staleSessions(sessions) {
    return sessions.filter(function (s) { return !digestOf(s); });
  }

  function dayOf(ts) {
    if (!ts) return '未知日期';
    var d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function monthOf(ts) {
    return ts ? dayOf(ts).slice(0, 7) : '未知月份';
  }

  function hhmm(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  }

  /** 会话健康度：给整库视图一个可排序的单一取值 */
  function severity(s) {
    var e = s.errors || {};
    var c = s.counts || {};
    if (e.protocol) return 'bad';
    if (e.compliance_failed) return 'bad';
    if ((c.write_attempts || 0) > (c.write_applied || 0)) return 'warn';
    return 'ok';
  }

  var SEVERITY_LABEL = { ok: '干净', warn: '有被拦下', bad: '有未通过/协议错误' };

  /** 会话有无问题的唯一定义（= severity 非 ok）。「仅有问题」筛选与决策清单都从这里取口径，
   * 渲染层与控制器不允许另写第二套判定。 */
  function isBad(s) {
    return severity(s) !== 'ok';
  }

  function severityText(s) {
    var e = s.errors || {};
    var c = s.counts || {};
    var parts = [];
    if (e.protocol) parts.push('协议错误 ' + e.protocol);
    if (e.compliance_failed) parts.push('合规未过 ' + e.compliance_failed);
    var denied = (c.write_attempts || 0) - (c.write_applied || 0);
    if (denied > 0) parts.push('被拦下 ' + denied);
    return parts.length ? parts.join(' · ') : '干净';
  }

  /* ── 架构基线 ─────────────────────────────────────────────────
   * 系统承重墙：按「被多少个会话改过」再按「改动次数」排序。
   * 不发明加权公式 —— 两个原始量都摆出来，排序依据写在界面上。
   * 领域架构分类阵列：按目录归类，是"现行生效的生产事实"的铺开视图。 */

  /**
   * 架构基线：把选中会话里"现在正在生效"的东西萃取出来。
   *
   * 两个子块的取舍：
   * - **系统承重墙**按「被多少个会话改过」再按「改动次数」排序。两个原始量都摆到界面上，
   *   不发明加权公式 —— 一旦引入神秘权重，读的人就只能选择相信或不信。
   *   聚合键必须用 `rel`（去掉 `.agents/trace/<会话>/` 前缀的路径），否则同一份文件会在每个会话里各算一条。
   * - **领域架构分类阵列**按目录归类，是"改动面铺开"的视图。
   *
   * @see [SPEC §7.3 四个区块](../../.agents/runner/SPEC.md#73-四个区块修正-v1-的编号与信息架构)
   * @trace s_20260915-160059_c5828f#3 实测：这里读到的 agentCapabilities 就是 initialize 那一步的返回值
   */
  function baseline(sessions) {
    var withDigest = sessions.filter(digestOf);
    var heavy = new Map();   // rel -> {rel, path, dir, writes, sessions}
    var cats = new Map();    // dir -> {dir, files:Set, writes, sessions:Set}
    var rules = new Map();   // rule_id -> {...}
    var fps = new Map();     // sha -> {sha, source, sessions}
    var caps = { protocol_version: null, agent: null, agent_info: null, client: null, sessions: 0 };

    sessions.forEach(function (s) {
      var d = digestOf(s);
      if (!d) return;
      (d.heavy_files || []).forEach(function (f) {
        // 按 rel（去掉会话目录的路径）聚合：同一份文件在多个会话里被改，应该合成一条
        var key = f.rel || f.path;
        if (!heavy.has(key)) heavy.set(key, { rel: key, path: f.path, dir: f.dir, writes: 0, sessions: 0 });
        var h = heavy.get(key);
        h.writes += f.writes;
        h.sessions += 1;
        // 目录归类也用 rel：这样同一份文件在不同会话里会落到同一个分类
        var dir = key.replace(/\/[^/]*$/, '') || '(根)';
        if (!cats.has(dir)) cats.set(dir, { dir: dir, files: new Set(), writes: 0, sessions: new Set() });
        var c = cats.get(dir);
        c.files.add(key);
        c.writes += f.writes;
        c.sessions.add(s.dir);
      });
      (d.rule_tally || []).forEach(function (t) {
        if (!rules.has(t.rule_id)) rules.set(t.rule_id, { rule_id: t.rule_id, rule_source: t.rule_source, total: 0, passed: 0, failed: 0, skipped: 0, error: 0, sessions: 0 });
        var r = rules.get(t.rule_id);
        r.total += t.total || 0;
        r.passed += t.passed || 0;
        r.failed += t.failed || 0;
        r.skipped += t.skipped || 0;
        r.error += t.error || 0;
        r.sessions += 1;
        if (t.rule_source) r.rule_source = t.rule_source;
      });
      if (s.rules_sha256_16) {
        var key = s.rules_sha256_16;
        if (!fps.has(key)) fps.set(key, { sha: key, source: s.rules_source || '—', sessions: 0 });
        fps.get(key).sessions += 1;
      }
      var cap = d.capabilities || {};
      if (cap.protocol_version != null) caps.protocol_version = cap.protocol_version;
      if (cap.agent) caps.agent = cap.agent;
      if (cap.agent_info) caps.agent_info = cap.agent_info;
      if (cap.client) caps.client = cap.client;
      caps.sessions += 1;
    });

    var heavyList = [...heavy.values()].sort(function (a, b) {
      return b.sessions - a.sessions || b.writes - a.writes || a.path.localeCompare(b.path);
    });

    return {
      sessions: sessions.length,
      withDigest: withDigest.length,
      stale: staleSessions(sessions).map(function (s) { return short(s.session_id); }),
      heavy: heavyList,
      categories: [...cats.values()].map(function (c) {
        return { dir: c.dir, files: c.files.size, writes: c.writes, sessions: c.sessions.size };
      }).sort(function (a, b) { return b.writes - a.writes || a.dir.localeCompare(b.dir); }),
      rules: [...rules.values()].sort(function (a, b) { return b.total - a.total; }),
      fingerprints: [...fps.values()].sort(function (a, b) { return b.sessions - a.sessions; }),
      caps: caps,
      totals: {
        files: heavyList.length,
        writes: heavyList.reduce(function (n, f) { return n + f.writes; }, 0),
      },
    };
  }

  /* ── 演进时间线 ─────────────────────────────────────────────── */

  var CATEGORY_OF_POLICY = { allow: 'allow 全放行', ask: 'ask 交互审批', deny: 'deny 全拒绝' };

  function evolutionScope(sessions) {
    var months = {};
    var cats = {};
    sessions.forEach(function (s) {
      months[monthOf(s.started_at)] = 1;
      var p = s.policy || '未知';
      cats[p] = 1;
    });
    return {
      months: Object.keys(months).sort().reverse(),
      categories: Object.keys(cats).sort(),
    };
  }

  function evolution(sessions, filter) {
    var f = filter || {};
    var list = sessions.filter(function (s) {
      if (f.month && f.month !== '全部' && monthOf(s.started_at) !== f.month) return false;
      if (f.category && f.category !== '全部' && (s.policy || '未知') !== f.category) return false;
      return true;
    });
    var groups = new Map();
    list.forEach(function (s) {
      var day = dayOf(s.started_at);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(s);
    });
    return [...groups.entries()]
      .sort(function (a, b) { return a[0] < b[0] ? 1 : -1; })
      .map(function (e) {
        return {
          date: e[0],
          items: e[1].sort(function (a, b) { return (b.started_at || 0) - (a.started_at || 0); }).map(function (s) {
            var c = s.counts || {};
            return {
              session: s,
              short: short(s.session_id),
              time: hhmm(s.started_at),
              policy: s.policy || '—',
              stopReason: s.stop_reason || '—',
              events: s.events_count || 0,
              writes: c.write_applied || 0,
              attempts: c.write_attempts || 0,
              denied: Math.max(0, (c.write_attempts || 0) - (c.write_applied || 0)),
              protoErrors: (s.errors || {}).protocol || 0,
              compFailed: (s.errors || {}).compliance_failed || 0,
              severity: severity(s),
            };
          }),
        };
      });
  }

  /* ── 避坑智库 ─────────────────────────────────────────────────
   * 「引用最多」= 同一目标 / 同一规则在全库被拦的次数，也就是重复踩同一个坑的次数。
   * 这是个真实可算的量，不是拿别处的"引用数"硬套。 */

  var METHOD_CATEGORY = {
    'fs/write_text_file': '写盘',
    'terminal/create': '命令',
    'session/request_permission': '授权',
  };

  function targetLabel(t) {
    if (!t) return '';
    var s = String(t).split('\\').join('/');
    s = s.replace(/^(?:.*\/)?\.agents\/trace\/[^/]+\//, '');
    return s;
  }

  function pitfalls(sessions, filter) {
    var f = filter || {};
    var rows = [];

    sessions.forEach(function (s) {
      var d = digestOf(s);
      if (!d) return;
      var base = { sessionShort: short(s.session_id), sessionDir: s.dir, date: s.started_at };

      (d.denied || []).forEach(function (x) {
        var cat = METHOD_CATEGORY[x.method] || '其它';
        rows.push(Object.assign({}, base, {
          seq: x.seq,
          ts: x.ts,
          category: cat,
          kind: x.kind,
          status: x.kind === 'permission' ? '已否决' : '已拦下',
          title: (cat === '命令' ? '命令被拦：' : '写盘被拒：') + (targetLabel(x.target) || x.method || ''),
          target: x.target,
          method: x.method,
          decidedBy: x.decided_by,
          refKey: x.target ? 'target:' + targetLabel(x.target) : 'method:' + x.method,
        }));
      });

      (d.compliance_failed || []).forEach(function (x) {
        rows.push(Object.assign({}, base, {
          seq: x.seq,
          ts: x.ts,
          category: '合规',
          kind: 'compliance',
          status: x.status === 'ERROR' ? '检查器出错' : '未通过',
          title: x.message,
          target: x.target,
          ruleId: x.rule_id,
          refKey: 'rule:' + x.rule_id,
        }));
      });
    });

    // 「引用」= 同一目标 / 同一规则在**多少个会话**里被拦过。
    // 按行计数会被"同一件事留两条记录"的协议接缝灌水（permission + blocked 各一条），
    // 按会话去重既准确又是真正想知道的量：这个坑在几个会话里踩过。
    var refMap = {};
    rows.forEach(function (r) {
      if (!refMap[r.refKey]) refMap[r.refKey] = {};
      refMap[r.refKey][r.sessionDir] = 1;
    });
    rows.forEach(function (r) { r.refs = Object.keys(refMap[r.refKey]).length; });

    var statuses = {};
    var cats = {};
    rows.forEach(function (r) { statuses[r.status] = 1; cats[r.category] = 1; });

    var filtered = rows.filter(function (r) {
      if (f.status && f.status !== '全部' && r.status !== f.status) return false;
      if (f.category && f.category !== '全部' && r.category !== f.category) return false;
      return true;
    });

    var sort = f.sort || 'newest';
    filtered.sort(function (a, b) {
      if (sort === 'oldest') return a.ts - b.ts || a.seq - b.seq;
      if (sort === 'refs') return b.refs - a.refs || b.ts - a.ts;
      return b.ts - a.ts || b.seq - a.seq;
    });

    return {
      rows: filtered,
      all: rows.length,
      options: {
        statuses: Object.keys(statuses).sort(),
        categories: Object.keys(cats).sort(),
      },
      repeated: rows.filter(function (r) { return r.refs > 1; }).length,
    };
  }

  /* ── 决策清单 ───────────────────────────────────────────────── */

  function ledger(sessions) {
    return sessions.slice().sort(function (a, b) { return (b.started_at || 0) - (a.started_at || 0); }).map(function (s, i) {
      var c = s.counts || {};
      return {
        no: i + 1,
        session: s,
        short: short(s.session_id),
        category: s.policy || '—',
        title: '会话 ' + short(s.session_id) + '（stopReason ' + (s.stop_reason || '—') + '）',
        status: severityText(s),
        severity: severity(s),
        date: s.started_at,
        changes: c.write_applied || 0,
        denied: Math.max(0, (c.write_attempts || 0) - (c.write_applied || 0)),
        events: s.events_count || 0,
      };
    });
  }

  /* ── 决策笔记（AGENTS.md §4 的消费端；数据来自 index.notes，构建期宿主已算好血缘）── */

  var NOTE_STATUS_LABEL = { implemented: '已落地', proposed: '待评审', rejected: '被否决', archived: '归档' };
  var NOTE_STATUS_CLASS = { implemented: 'chip-ok', proposed: 'chip-warn', rejected: 'chip-bad', archived: 'chip-skip' };
  var NOTE_CLASS_LABEL = {
    architecture: '架构设计', feature: '功能特性', 'bug-fix': '缺陷修复',
    simplification: '化简裁撤', process: '流程规范', testing: '测试基建',
  };

  function noteList(index) {
    return index && Array.isArray(index.notes) ? index.notes : [];
  }

  /** 取笔记某一节的正文（如「放弃方案」），供避坑卡片拆块展示 */
  function noteSection(note, name) {
    var lines = String(note.body || '').split('\n');
    var out = [];
    var inSec = false;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (/^##\s/.test(l)) {
        if (inSec) break;
        inSec = l.replace(/^##\s*/, '').trim() === name;
        continue;
      }
      if (inSec) out.push(l);
    }
    return out.join('\n').trim();
  }

  /** 笔记聚合：KPI 计数 / 承重墙（被引用排序）/ 分类面板 / 按日时间线；query 为顶栏全局搜索 */
  function notesModel(notes, query) {
    var f = String(query || '').trim().toLowerCase();
    var list = notes.filter(function (n) {
      if (!f) return true;
      return (n.title + ' ' + n.id + ' ' + n.body).toLowerCase().indexOf(f) >= 0;
    });
    var byStatus = { implemented: 0, proposed: 0, rejected: 0, archived: 0 };
    list.forEach(function (n) { if (byStatus[n.status] != null) byStatus[n.status]++; });
    var heavy = list.filter(function (n) { return n.refd_by && n.refd_by.length > 0; })
      .sort(function (a, b) { return b.refd_by.length - a.refd_by.length || (b.date || '').localeCompare(a.date || ''); });
    var catMap = new Map();
    list.forEach(function (n) {
      if (!catMap.has(n.category)) catMap.set(n.category, []);
      catMap.get(n.category).push(n);
    });
    var cats = Array.from(catMap.entries()).map(function (e) { return { category: e[0], items: e[1] }; })
      .sort(function (a, b) { return b.items.length - a.items.length || a.category.localeCompare(b.category); });
    var dayMap = new Map();
    list.forEach(function (n) {
      var d = n.date || '未知日期';
      if (!dayMap.has(d)) dayMap.set(d, []);
      dayMap.get(d).push(n);
    });
    var days = Array.from(dayMap.entries()).map(function (e) { return { date: e[0], items: e[1] }; })
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    return { total: notes.length, shown: list.length, byStatus: byStatus, heavy: heavy, cats: cats, days: days };
  }

  return {
    short: short,
    digestOf: digestOf,
    staleSessions: staleSessions,
    dayOf: dayOf,
    monthOf: monthOf,
    hhmm: hhmm,
    severity: severity,
    severityText: severityText,
    isBad: isBad,
    SEVERITY_LABEL: SEVERITY_LABEL,
    NOTE_STATUS_LABEL: NOTE_STATUS_LABEL,
    NOTE_STATUS_CLASS: NOTE_STATUS_CLASS,
    NOTE_CLASS_LABEL: NOTE_CLASS_LABEL,
    noteList: noteList,
    noteSection: noteSection,
    notesModel: notesModel,
    baseline: baseline,
    evolutionScope: evolutionScope,
    evolution: evolution,
    pitfalls: pitfalls,
    ledger: ledger,
    targetLabel: targetLabel,
    CATEGORY_OF_POLICY: CATEGORY_OF_POLICY,
  };
})();

globalThis.TraceAggregate = TraceAggregate;
