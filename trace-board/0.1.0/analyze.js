/* 分析层：把 events.jsonl 的原始事件流转成视图要用的几个模型。
 * 这一层不碰 DOM，纯函数，方便单测与复用。
 *
 * 事件的三个关键字段（来自 SPEC.md §5.1）：
 *   seq        单调递增，排序与定位的唯一依据
 *   turn_seq   属于哪一轮 session/prompt（该 prompt 事件的 seq）
 *   parent_seq 血缘：谁触发了它 —— 缩进层级就是沿这个链数出来的
 */
var TraceAnalyze = (function () {
  'use strict';

  var DIR_LABEL = {
    'client->agent': '宿主 → agent',
    'agent->client': 'agent → 宿主',
    internal: '宿主内部'
  };

  /* 合规状态的唯一权威表：label（文案）/ cls（chip 类名）/ rank（展示排序，小者在前）。
   * 状态、chip 类名、排序序、概要口径全部从这里派生，禁止在渲染层再写第二套映射 ——
   * runner 扩枚举时改这一张表即可，漏改会被 trace-board/tests/contract-test.mjs 拦下。
   * @see [SPEC §5.8 看板入口索引与 digest schema](../../.agents/runner/SPEC.md#58-看板入口索引与-digest-schema)
   * @see [SPEC §6.2 状态枚举](../../.agents/runner/SPEC.md#62-状态枚举五种v1-只有一种)
   */
  var COMPLIANCE_STATUS = {
    FAILED: { label: '未通过', cls: 'chip-bad', rank: 0 },
    ERROR: { label: '检查器出错', cls: 'chip-bad', rank: 1 },
    WARN: { label: '提示', cls: 'chip-warn', rank: 2 },
    PASSED: { label: '通过', cls: 'chip-ok', rank: 3 },
    SKIPPED: { label: '不适用', cls: 'chip-skip', rank: 4 },
  };
  // 旧导出名保留（eventTail / 兜底 chip 渲染还在用），值从单表派生
  var STATUS_LABEL = {};
  var STATUS_CLASS = {};
  Object.keys(COMPLIANCE_STATUS).forEach(function (k) {
    STATUS_LABEL[k] = COMPLIANCE_STATUS[k].label;
    STATUS_CLASS[k] = COMPLIANCE_STATUS[k].cls;
  });

  /** 展示排序键：未知状态排到最后（防御性降级，不抛错） */
  function statusRank(status) {
    var d = COMPLIANCE_STATUS[status];
    return d ? d.rank : COMPLIANCE_STATUS.SKIPPED.rank + 1;
  }

  /** 检查结果标题的计数串：FAILED 恒显示（"未通过 0"是安定信息），其余只在出现时显示 */
  function statusHeadline(byStatus) {
    return Object.keys(COMPLIANCE_STATUS)
      .sort(function (a, b) { return COMPLIANCE_STATUS[a].rank - COMPLIANCE_STATUS[b].rank; })
      .filter(function (k) { return k === 'FAILED' || (byStatus[k] || 0) > 0; })
      .map(function (k) { return COMPLIANCE_STATUS[k].label + ' ' + (byStatus[k] || 0); });
  }

  /* ── 格式化 ─────────────────────────────────────────────────── */

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  function fmtTime(ms) {
    if (!ms) return '—';
    var d = new Date(ms);
    return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2);
  }

  function fmtDateTime(ms) {
    if (!ms) return '—';
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) +
      ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2);
  }

  function fmtDuration(ms) {
    if (ms == null || ms < 0) return '—';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's';
  }

  function fmtBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  /** 去掉会话目录前缀，让路径读起来是"项目内路径"
   *  事件里的 path 是绝对路径（协议要求），所以要么匹配 `…/.agents/trace/<会话>/`，
   *  要么匹配索引里的相对会话目录名。两种都处理。 */
  function shortPath(p, dir) {
    var s = TraceSource.norm(p);
    s = s.replace(/^(?:.*\/)?\.agents\/trace\/[^/]+\//, '');
    if (dir && s.indexOf(TraceSource.norm(dir) + '/') === 0) s = s.slice(TraceSource.norm(dir).length + 1);
    return s;
  }

  function eventLabel(e) {
    if (e.compliance_check) return 'compliance/check';
    return e.method || '(未知)';
  }

  /* ── 血缘层级 ───────────────────────────────────────────────── */

  function withDepth(events) {
    var bySeq = new Map();
    events.forEach(function (e) { bySeq.set(e.seq, e); });
    return events.map(function (e) {
      var d = 0;
      var cur = e;
      while (cur && cur.parent_seq != null && d < 6) {
        var p = bySeq.get(cur.parent_seq);
        if (!p) break;
        d++;
        cur = p;
      }
      return { e: e, depth: d };
    });
  }

  /* ── 回合分组 ───────────────────────────────────────────────── */

  function groupTurns(events) {
    var map = new Map();
    events.forEach(function (e) {
      var key = e.turn_seq == null ? 0 : e.turn_seq;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    });

    var keys = Array.from(map.keys()).sort(function (a, b) {
      return a === 0 ? 1 : b === 0 ? -1 : a - b;
    });

    return keys.map(function (key) {
      var list = map.get(key).slice().sort(function (a, b) { return a.seq - b.seq; });
      var root = list.find(function (e) { return e.seq === key; }) || null;
      var prompt = root && root.acp_message && root.acp_message.params;
      var contentKinds = [];
      if (prompt && Array.isArray(prompt.content)) {
        prompt.content.forEach(function (c) { contentKinds.push(c.type || '?'); });
      }
      return {
        key: key,
        isPreamble: key === 0,
        label: key === 0 ? '会话前 / 后（不属于任何回合）' : '回合 #' + key,
        root: root,
        promptKinds: contentKinds,
        note: root ? 'session/prompt' : map.get(key).length + ' 条',
        span: list.length ? (list[list.length - 1].ts - list[0].ts) : 0,
        items: withDepth(list)
      };
    });
  }

  /* ── 会话概要 ───────────────────────────────────────────────── */

  function summarize(events, session) {
    var start = events.length ? events[0].ts : (session && session.started_at) || null;
    var end = events.length ? events[events.length - 1].ts : (session && session.ended_at) || null;
    var comp = events.filter(function (e) { return e.compliance_check; });
    var proto = events.filter(function (e) { return e.protocol && e.protocol.status === 'ERROR'; });
    var resp = events.filter(function (e) { return e.kind === 'response' && e.dir === 'client->agent'; });
    var byStatus = {};
    Object.keys(COMPLIANCE_STATUS).forEach(function (k) { byStatus[k] = 0; });
    comp.forEach(function (e) {
      var s = e.compliance_check.status;
      if (byStatus[s] == null) byStatus[s] = 0;
      byStatus[s]++;
    });
    return {
      events: events.length,
      turns: groupTurns(events).filter(function (t) { return !t.isPreamble; }).length,
      span: start && end ? end - start : null,
      started_at: start,
      ended_at: end,
      protocolErrors: proto.length,
      compliance: { total: comp.length, byStatus: byStatus },
      deniedWrites: resp.filter(function (e) {
        return e.acp_message && e.acp_message.error && e.acp_message.error.code === -32001;
      }).length,
      notified: events.filter(function (e) { return e.kind === 'notification'; }).length
    };
  }

  /* ── 方法清单（时间线头部）──────────────────────────────────── */

  function methodInventory(events) {
    var map = new Map();
    events.forEach(function (e) {
      if (!e.method || e.kind === 'mark' || e.kind === 'compliance') return;
      var key = e.dir + ' ' + e.method;
      if (!map.has(key)) {
        map.set(key, {
          dir: e.dir, method: e.method, count: 0,
          stability: (e.protocol && e.protocol.stability) || null,
          badName: (e.protocol && e.protocol.known_bad_name) || null,
          hasError: false
        });
      }
      var row = map.get(key);
      row.count++;
      if (e.protocol && e.protocol.status === 'ERROR') row.hasError = true;
      if (e.protocol && e.protocol.known_bad_name) row.badName = e.protocol.known_bad_name;
    });
    return Array.from(map.values()).sort(function (a, b) {
      if (a.hasError !== b.hasError) return a.hasError ? -1 : 1;
      return b.count - a.count;
    });
  }

  /* ── 合规清单 ───────────────────────────────────────────────── */

  function complianceItems(events) {
    var bySeq = new Map();
    events.forEach(function (e) { bySeq.set(e.seq, e); });
    return events.filter(function (e) { return e.compliance_check; }).map(function (e) {
      var r = e.compliance_check;
      var parent = e.parent_seq != null ? bySeq.get(e.parent_seq) : null;
      var target = null;
      if (parent && parent.acp_message && parent.acp_message.params) {
        var p = parent.acp_message.params;
        target = p.path || (Array.isArray(p.command) ? p.command.join(' ') : p.command) || null;
      } else if (r.details && r.details.plugin_dir) {
        target = r.details.plugin_dir;
      }
      return {
        seq: e.seq,
        rule_id: r.rule_id,
        rule_source: r.rule_source,
        status: r.status,
        message: r.message,
        details: r.details || {},
        target: target,
        normalized: parent && parent.trace_normalized ? parent.trace_normalized : null
      };
    });
  }

  function rulesUsed(items) {
    var map = new Map();
    items.forEach(function (it) {
      if (!map.has(it.rule_id)) map.set(it.rule_id, { rule_id: it.rule_id, rule_source: it.rule_source, count: 0, failed: 0 });
      var row = map.get(it.rule_id);
      row.count++;
      if (it.status === 'FAILED') row.failed++;
    });
    return Array.from(map.values());
  }

  /* ── 实际落盘的改动 ─────────────────────────────────────────── */

  function appliedWrites(events) {
    var bySeq = new Map();
    events.forEach(function (e) { bySeq.set(e.seq, e); });
    return events.filter(function (e) { return e.method === 'fs/write_applied'; }).map(function (e) {
      var parent = e.parent_seq != null ? bySeq.get(e.parent_seq) : null;
      var diffFile = (e.payload && e.payload.diff_file) || null;
      return {
        seq: e.seq,
        parentSeq: e.parent_seq,
        path: e.payload.path,
        created: !!e.payload.created,
        beforeLines: e.payload.before_lines,
        afterLines: e.payload.after_lines,
        diffFile: diffFile,
        diffName: diffFile ? diffFile.replace(/^.*\//, '') : null,
        normalized: parent && parent.trace_normalized ? parent.trace_normalized : null
      };
    });
  }

  function executedCommands(events) {
    return events.filter(function (e) { return e.method === 'terminal/created'; }).map(function (e) {
      return { seq: e.seq, command: (e.payload && e.payload.command) || [], cwd: e.payload && e.payload.cwd, pid: e.payload && e.payload.pid };
    });
  }

  /* ── 被否决：一条 trace 里最值钱的部分 ──────────────────────── */

  /**
   * 被否决清单：一条 trace 里最值钱的往往是"想过但没做"的部分。
   *
   * ACP 的 `session/request_permission` 与随后的 `fs/write_text_file` / `terminal/create`
   * **之间没有关联字段**，所以同一件事会在事件流里留下两条记录。这里按
   * 「同回合 + 同方法 + 相邻」把它们归成一条 —— 就是 SPEC 里推荐的方案 A：两次都拦，看板合成一条展示。
   * 归组条目上的 `alsoBlocked` 保留了"随后被拦下"这个事实，界面上要说明为什么本来是两条。
   *
   * @see [SPEC §4.5 已知接缝：审批与后续调用没有关联字段](../../.agents/runner/SPEC.md#45-已知接缝审批与后续调用没有关联字段-)
   * @trace s_20260915-181326_91808b#21 实测：permission(#21) 与随后的 -32001(#22) 是同一件事的两条记录
   */
  function deniedItems(events) {
    var bySeq = new Map();
    events.forEach(function (e) { bySeq.set(e.seq, e); });
    var out = [];

    // 1) 审批决定里被拒的
    events.filter(function (e) { return e.method === 'approval/decision' && e.payload && e.payload.approved === false; })
      .forEach(function (e) {
        out.push({
          seq: e.seq,
          turnSeq: e.turn_seq,
          kind: 'permission',
          method: e.payload.method,
          decidedBy: e.payload.decided_by,
          risk: (bySeq.get(e.parent_seq) && bySeq.get(e.parent_seq).risk_level) || null,
          reason: null,
          target: null,
          latency: e.payload.latency_ms
        });
      });

    // 2) 顺着 -32001 的错误响应，把"到底拒了哪个文件/命令"捞出来
    events.filter(function (e) {
      return e.dir === 'client->agent' && e.acp_message && e.acp_message.error && e.acp_message.error.code === -32001;
    }).forEach(function (e) {
      var parent = e.parent_seq != null ? bySeq.get(e.parent_seq) : null;
      var target = null;
      var method = parent ? parent.method : null;
      if (parent && parent.acp_message && parent.acp_message.params) {
        var p = parent.acp_message.params;
        target = p.path || (Array.isArray(p.command) ? p.command.join(' ') : p.command) || null;
      }
      out.push({
        seq: e.seq,
        turnSeq: e.turn_seq,
        kind: 'blocked',
        method: method,
        decidedBy: (e.acp_message.error.data && e.acp_message.error.data.decided_by) || null,
        risk: null,
        reason: e.acp_message.error.message,
        target: target,
        latency: null
      });
    });

    out.sort(function (a, b) { return a.seq - b.seq; });

    /* 归组：ACP 的 session/request_permission 与随后的 terminal/create / fs.write_text_file
     * **之间没有关联字段**（SPEC §4.5 的已知接缝），所以同一件事会留下两条记录。
     * 这里按「同回合 + 同方法 + 相邻」做归组 —— 就是 SPEC 里推荐的方案 A：
     * 两次都拦，但看板合成一条展示，不重复打扰。 */
    var merged = [];
    out.forEach(function (item) {
      var host = null;
      if (item.kind === 'blocked') {
        for (var i = merged.length - 1; i >= 0 && i >= merged.length - 2; i--) {
          var cand = merged[i];
          if (cand.kind === 'permission' && !cand.alsoBlocked &&
              cand.turnSeq === item.turnSeq && cand.method === item.method) {
            host = cand;
            break;
          }
        }
      }
      if (host) {
        host.alsoBlocked = { seq: item.seq, target: item.target, decidedBy: item.decidedBy, reason: item.reason };
      } else {
        merged.push(item);
      }
    });
    return merged;
  }

  /* ── 协议错误（方法名/方向问题）─────────────────────────────── */

  function protocolErrors(events) {
    return events.filter(function (e) { return e.protocol && e.protocol.status === 'ERROR'; }).map(function (e) {
      return {
        seq: e.seq,
        dir: e.dir,
        method: e.method,
        code: e.protocol.error && e.protocol.error.code,
        message: e.protocol.error && e.protocol.error.message,
        hint: e.protocol.error && e.protocol.error.hint,
        knownBadName: e.protocol.known_bad_name || null
      };
    });
  }

  /* ── Diff 文本 → 带行类型的数组（渲染前先分好类，避免 innerHTML）── */

  function splitDiff(text) {
    return String(text || '').split('\n').map(function (line) {
      var cls = 'dl';
      if (line.indexOf('@@') === 0) cls = 'dl dl-hunk';
      else if (line.indexOf('+++') === 0 || line.indexOf('---') === 0) cls = 'dl dl-meta';
      else if (line.charAt(0) === '+') cls = 'dl dl-add';
      else if (line.charAt(0) === '-') cls = 'dl dl-del';
      return { cls: cls, text: line };
    });
  }

  function diffStat(text) {
    var add = 0;
    var del = 0;
    var hunks = 0;
    splitDiff(text).forEach(function (l) {
      if (l.cls.indexOf('dl-hunk') >= 0) hunks++;
      else if (l.cls.indexOf('dl-add') >= 0) add++;
      else if (l.cls.indexOf('dl-del') >= 0) del++;
    });
    return { add: add, del: del, hunks: hunks };
  }

  return {
    DIR_LABEL: DIR_LABEL,
    COMPLIANCE_STATUS: COMPLIANCE_STATUS,
    STATUS_LABEL: STATUS_LABEL,
    STATUS_CLASS: STATUS_CLASS,
    statusRank: statusRank,
    statusHeadline: statusHeadline,
    fmtTime: fmtTime,
    fmtDateTime: fmtDateTime,
    fmtDuration: fmtDuration,
    fmtBytes: fmtBytes,
    shortPath: shortPath,
    eventLabel: eventLabel,
    withDepth: withDepth,
    groupTurns: groupTurns,
    summarize: summarize,
    methodInventory: methodInventory,
    complianceItems: complianceItems,
    rulesUsed: rulesUsed,
    appliedWrites: appliedWrites,
    executedCommands: executedCommands,
    deniedItems: deniedItems,
    protocolErrors: protocolErrors,
    splitDiff: splitDiff,
    diffStat: diffStat
  };
})();

globalThis.TraceAnalyze = TraceAnalyze;
