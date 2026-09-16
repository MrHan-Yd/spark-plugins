#!/usr/bin/env node
// 追溯回查（recall）：给 agent 自己用的查询面 —— 读 .agents/trace 的既有落盘，回答
// 「这个路径历史上被拦过几次 / 这条规则挂过几次 / 有没有相关的决策笔记」。
// 与 trace-report.mjs（人看的回放）同层：纯读盘、零后端、永远 exit 0 ——
// 查询失败不该打断干活中的 agent，输出里如实说明空结果即可。
//
// 用法（参数即语义，结果都是给人与 agent 双方可读的文本）：
//   node recall.mjs --path trace-board/0.1.0/app.js   # 这个文件的写盘/被拦/合规历史
//   node recall.mjs --rule TRACE_WHY_ANCHORED         # 这条规则的通过/未通过台账
//   node recall.mjs --denied                          # 全库被拦/被拒清单（按目标去重）
//   三者可带 --limit N（默认 20），--json 输出机器可读 JSON。
// @see [SPEC §5.9 agent 回查通道](SPEC.md#59-agent-回查通道recall)
import fs from 'node:fs';
import path from 'node:path';
import { collect } from './trace-index.mjs';

const TRACE_ROOT_REL = '.agents/trace';
const NOTES_ROOT_REL = '.agents/notes';

const argv = process.argv.slice(2);
const argOf = (flag, def) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : def;
};
const wantPath = argOf('--path', null);
const wantRule = argOf('--rule', null);
const wantDenied = argv.includes('--denied');
const wantNotes = argv.includes('--notes');
const jsonOut = argv.includes('--json');
const limit = Math.max(1, Number(argOf('--limit', '20')) || 20);

/** 路径匹配按「剥掉会话目录前缀 + 双向归一」做：trace 里的 payload path 是相对项目根的，
 * agent 查询时可能带也可能不带 .agents/trace/<会话>/ 前缀，剥齐再比，尾斜杠差异也抹掉。 */
function normRel(p) {
  return String(p || '').split('\\').join('/').replace(/\/+$/, '');
}

function targetMatches(target, query) {
  const rel = normRel(target).replace(/^\.agents\/trace\/[^/]+\//, '');
  const q = normRel(query);
  return rel === q || rel.endsWith('/' + q) || q.endsWith('/' + rel);
}

function shortPath(p) {
  return normRel(p).replace(/^\.agents\/trace\/[^/]+\//, '');
}

function loadAll() {
  const cwd = process.cwd();
  const traceRoot = path.join(cwd, TRACE_ROOT_REL);
  if (!fs.existsSync(traceRoot)) return { index: { sessions: [], notes: [] }, sessions: [] };
  return collect({ cwd });
}

function recallPath(query) {
  const { index, sessions } = loadAll();
  const hits = [];
  for (const { meta, events } of sessions) {
    const bySeq = new Map(events.map((e) => [e.seq, e]));
    for (const e of events) {
      const parent = e.parent_seq != null ? bySeq.get(e.parent_seq) : null;
      const pp = parent?.acp_message?.params ?? e.payload ?? {};
      const p = pp.path ?? e.payload?.path ?? null;
      if (!p || !targetMatches(p, query)) continue;
      // 命中行的分类与 pitfalls 同一口径：落盘 / 审批被拒 / 执行被拦 / 合规未过
      if (e.method === 'fs/write_applied') {
        hits.push({ session: meta.session_id, dir: meta.dir, seq: e.seq, kind: '写盘', detail: `${shortPath(p)} · ${e.payload?.before_lines ?? '?'}→${e.payload?.after_lines ?? '?'} 行`, ts: e.ts });
      } else if (e.method === 'approval/decision' && e.payload?.approved === false) {
        hits.push({ session: meta.session_id, dir: meta.dir, seq: e.seq, kind: '审批被拒', detail: `${e.payload?.method ?? '?'} ${shortPath(p)}`, ts: e.ts });
      } else if (e.dir === 'client->agent' && e.acp_message?.error?.code === -32001) {
        hits.push({ session: meta.session_id, dir: meta.dir, seq: e.seq, kind: '执行被拦', detail: `${parent?.method ?? '?'} ${shortPath(p)}`, ts: e.ts });
      } else if (e.compliance_check && (e.compliance_check.status === 'FAILED' || e.compliance_check.status === 'ERROR')) {
        hits.push({ session: meta.session_id, dir: meta.dir, seq: e.seq, kind: '合规未过', detail: `${e.compliance_check.rule_id}：${e.compliance_check.message}`, ts: e.ts });
      }
    }
  }
  // 笔记是知识层：正文里提到这个路径的笔记一并给 —— 路径的历史决策往往就在笔记里
  const noteHits = (index.notes || []).filter((n) => n.body.includes(query))
    .map((n) => ({ file: n.file, status: n.status, title: n.title, id: n.id }));
  return { query, hits: hits.sort((a, b) => (b.ts || 0) - (a.ts || 0)), notes: noteHits };
}

function recallRule(ruleId) {
  const { index, sessions } = loadAll();
  const tally = { rule_id: ruleId, total: 0, passed: 0, failed: 0, skipped: 0, error: 0 };
  const failed = [];
  for (const { meta, events } of sessions) {
    for (const e of events) {
      const r = e.compliance_check;
      if (!r || r.rule_id !== ruleId) continue;
      tally.total++;
      const k = String(r.status || '').toLowerCase();
      if (k in tally) tally[k]++;
      if (r.status === 'FAILED' || r.status === 'ERROR') {
        const parent = e.parent_seq != null ? events.find((x) => x.seq === e.parent_seq) : null;
        failed.push({
          session: meta.session_id, seq: e.seq, status: r.status,
          message: r.message,
          // 写盘事件的路径在 payload，反向调用的在 acp_message.params —— 两个位置都解
          target: parent?.acp_message?.params?.path ?? parent?.payload?.path ?? r.details?.plugin_dir ?? null,
        });
      }
    }
  }
  return { rule: tally, failed: failed.slice(0, limit), notes: (index.notes || []).filter((n) => n.body.includes(ruleId)).map((n) => ({ file: n.file, status: n.status, title: n.title })) };
}

function recallDenied() {
  const { index, sessions } = loadAll();
  const byTarget = new Map();
  for (const { meta, events } of sessions) {
    const bySeq = new Map(events.map((e) => [e.seq, e]));
    for (const e of events) {
      let target = null, kind = null, decidedBy = null;
      if (e.method === 'approval/decision' && e.payload?.approved === false) {
        const parent = e.parent_seq != null ? bySeq.get(e.parent_seq) : null;
        const pp = parent?.acp_message?.params;
        kind = '审批被拒';
        decidedBy = e.payload.decided_by;
        const t = pp?.path ?? (Array.isArray(pp?.command) ? pp.command.join(' ') : null);
        if (t) target = t;
      } else if (e.dir === 'client->agent' && e.acp_message?.error?.code === -32001) {
        const parent = e.parent_seq != null ? bySeq.get(e.parent_seq) : null;
        const pp = parent?.acp_message?.params;
        kind = '执行被拦';
        decidedBy = e.acp_message.error.data?.decided_by;
        const t = pp?.path ?? (Array.isArray(pp?.command) ? pp.command.join(' ') : null);
        if (t) target = t;
      } else if (e.compliance_check && e.compliance_check.status === 'FAILED') {
        const parent = e.parent_seq != null ? bySeq.get(e.parent_seq) : null;
        kind = '合规未过';
        const t = parent?.acp_message?.params?.path ?? e.compliance_check.details?.plugin_dir ?? null;
        if (t) target = t;
      }
      if (!target) continue;
      const rel = normRel(target).replace(/^\.agents\/trace\/[^/]+\//, '');
      const key = kind + ':' + rel;
      if (!byTarget.has(key)) byTarget.set(key, { kind, target: rel, sessions: [], decidedBy: [] });
      const slot = byTarget.get(key);
      if (!slot.sessions.includes(meta.session_id)) slot.sessions.push(meta.session_id);
      if (decidedBy) slot.decidedBy = decidedBy;
    }
  }
  return { denied: [...byTarget.values()].sort((a, b) => b.sessions.length - a.sessions.length).slice(0, limit), notes: (index.notes || []).filter((n) => n.status === 'rejected').map((n) => ({ file: n.file, title: n.title })) };
}

function recallNotes() {
  const { index } = loadAll();
  return { notes: (index.notes || []).map((n) => ({ file: n.file, status: n.status, category: n.category, title: n.title, id: n.id })) };
}

function renderTable(rows) {
  if (!rows.length) return ['（没有匹配的记录）'];
  return rows.map((r) =>
    `${r.sessions ? `[${r.sessions.length} 会话] ` : ''}${r.kind ? r.kind + ' ' : ''}${r.target ?? r.rule ?? ''}${r.decidedBy ? ` · 由 ${r.decidedBy} 决定` : ''}`);
}

function main() {
  if (!wantPath && !wantRule && !wantDenied && !wantNotes) {
    process.stdout.write([
      '追溯回查：用法（永远 exit 0，空结果如实说明）',
      '  node recall.mjs --path <项目相对路径>   该文件的写盘/被拦/合规历史 + 相关笔记',
      '  node recall.mjs --rule <rule_id>        该检查器的通过/未通过台账',
      '  node recall.mjs --denied                全库被拦/被拒清单（按目标聚合）',
      '  node recall.mjs --notes                 全库决策笔记清单',
      '  可带 --limit N（默认 20）与 --json。',
    ].join('\n') + '\n');
    return 0;
  }

  let data;
  if (wantPath) data = recallPath(wantPath);
  else if (wantRule) data = recallRule(wantRule);
  else if (wantDenied) data = recallDenied();
  else data = recallNotes();

  if (jsonOut) {
    process.stdout.write(JSON.stringify(data) + '\n');
    return 0;
  }

  const out = [];
  if (wantPath) {
    out.push(`== ${wantPath} 的追溯历史（${data.hits.length} 条，取前 ${limit}）==`);
    for (const h of data.hits.slice(0, limit)) {
      out.push(`  ${h.session}#${h.seq} ${h.kind}：${h.detail}`);
    }
    if (data.hits.length > limit) out.push(`  …另有 ${data.hits.length - limit} 条`);
    if (data.notes.length) {
      out.push('  相关决策笔记：');
      for (const n of data.notes) out.push(`    [${n.status}] ${n.title}（${n.file}）`);
    }
  } else if (wantRule) {
    out.push(`== ${wantRule}：共 ${data.rule.total} 次 · 通过 ${data.rule.passed} · 未通过 ${data.rule.failed} · 不适用 ${data.rule.skipped}${data.rule.error ? ` · 出错 ${data.rule.error}` : ''} ==`);
    for (const f of data.failed) {
      out.push(`  ${f.session}#${f.seq} [${f.status}] ${f.message}${f.target ? `（对象 ${shortPath(f.target)}）` : ''}`);
    }
    if (data.notes.length) {
      out.push('  相关决策笔记：');
      for (const n of data.notes) out.push(`    [${n.status}] ${n.title}（${n.file}）`);
    }
  } else if (wantDenied) {
    out.push(`== 全库被拦/被拒（按目标聚合，${data.denied.length} 个目标）==`);
    for (const d of data.denied) {
      out.push(`  [${d.kind}] ${d.target} —— ${d.sessions.length} 个会话${d.decidedBy ? ` · 最近由 ${d.decidedBy} 决定` : ''}`);
    }
    if (data.notes.length) {
      out.push('  避坑笔记（rejected）：');
      for (const n of data.notes) out.push(`    ${n.title}（${n.file}）`);
    }
  } else {
    out.push(`== 决策笔记（${data.notes.length} 篇）==`);
    for (const n of data.notes) out.push(`  [${n.status}/${n.category}] ${n.title}（${n.file}）`);
  }
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  // 回查永不打断干活中的 agent：任何异常都只如实说明 + exit 0
  process.stdout.write(`回查失败（不影响当前任务）：${e?.message ?? e}\n`);
  process.exit(0);
}