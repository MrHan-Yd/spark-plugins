#!/usr/bin/env node
// 追溯索引：给看板用的入口文件。
//
// 为什么必须有它：插件页的 spark.fs 只有 read/write，**没有目录列举**。
// 所以看板不可能"打开一个目录自己扫"，它只能读一个已知路径的索引，再按索引里给的相对路径去读文件。
// 同一份索引同时也是 HTTP 远程模式的入口（远程库只要把 index.json 和会话目录一起托管即可）。
// @see [SPEC 附录 A2 看板的参考实现（两处宿主约束）](SPEC.md#附录-a2--看板的参考实现)
//
// 用法：
//   node trace-index.mjs                        # 重建 .agents/trace/index.json
//   node trace-index.mjs --bundle out.json      # 另导出自包含单文件（事件与 diff 全部内联），可直接托管
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TRACE_ROOT_REL = path.join('.agents', 'trace');
/** 决策笔记根（AGENTS.md §4）：在项目根下、与 trace 平级——笔记是进 git 的知识，trace 是运行产物 */
const NOTES_ROOT_REL = path.join('.agents', 'notes');
const NOTE_BODY_LIMIT = 16_000;
/** 笔记条数上限：索引内联正文，几百篇 KB 级笔记不构成压力，超了只收前 N 篇并置 truncated */
const NOTES_CAP = 400;
const NOTE_STATUSES = ['proposed', 'implemented', 'rejected', 'archived'];
const DIFF_INLINE_LIMIT = 24_000;
/** 每会话内联进索引的 diff 条数上限：超出的只记 files.diffs 路径并置 diffs_inline_truncated，
 * 看板 loadDiff 自动回落到按路径读。不封顶的话索引随「会话数 × diff 数」线性膨胀，
 * HTTP 远程模式会撞 10MB 响应上限。bundle 模式不受此限（单文件必须自包含）。
 * @see [SPEC §5.8 看板入口索引与 digest schema](SPEC.md#58-看板入口索引与-digest-schema) */
const DIFF_INLINE_MAX = 4;
/** 摘要上限：够看板做项目级/全库级聚合，又不至于把 index.json 撑大 */
const DIGEST_CAPS = { heavy_files: 40, compliance_failed: 60, denied: 60, protocol_errors: 40 };
/**
 * 会话摘要（digest）
 * 为什么放进索引：看板要出「架构基线 / 演进时间线 / 避坑智库 / 决策清单」这些**跨会话**视图。
 * 若靠看板逐个会话拉 events.jsonl，就是 N+1 次请求（HTTP 远程模式下尤其难受）。
 * 这里在宿主侧一次性算好小体积摘要，看板只读一次索引即可。
 */
function buildDigest(events) {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const heavy = new Map();
  const compliance = [];
  const denied = [];
  const proto = [];

  for (const e of events) {
    // 承重墙的原料：每个被落盘的文件被改了几次
    if (e.method === 'fs/write_applied' && e.payload?.path) {
      heavy.set(e.payload.path, (heavy.get(e.payload.path) || 0) + 1);
    }
    if (e.compliance_check) {
      const r = e.compliance_check;
      if (r.status === 'FAILED' || r.status === 'ERROR') {
        const parent = e.parent_seq != null ? bySeq.get(e.parent_seq) : null;
        compliance.push({
          seq: e.seq,
          rule_id: r.rule_id,
          rule_source: r.rule_source,
          status: r.status,
          message: r.message,
          target: parent?.acp_message?.params?.path || r.details?.plugin_dir || null,
          ts: e.ts,
        });
      }
    }
    if (e.method === 'approval/decision' && e.payload?.approved === false) {
      // 审批被拒也要把"到底拒了哪个文件/命令"解出来：
      // 审批事件的 parent 就是那次反向调用，参数里才有 path/command。
      // 不解出来的话，看板只能退化成按方法名统计，"引用最多"会变成一堆无意义的 49。
      const parent = e.parent_seq != null ? bySeq.get(e.parent_seq) : null;
      const pp = parent?.acp_message?.params;
      denied.push({
        seq: e.seq,
        kind: 'permission',
        method: e.payload.method,
        target: pp?.path || (Array.isArray(pp?.command) ? pp.command.join(' ') : pp?.command) || null,
        decided_by: e.payload.decided_by,
        ts: e.ts,
      });
    }
    if (e.dir === 'client->agent' && e.acp_message?.error?.code === -32001) {
      const parent = e.parent_seq != null ? bySeq.get(e.parent_seq) : null;
      const p = parent?.acp_message?.params;
      denied.push({
        seq: e.seq,
        kind: 'blocked',
        method: parent?.method || null,
        target: p?.path || (Array.isArray(p?.command) ? p.command.join(' ') : p?.command) || null,
        decided_by: e.acp_message.error.data?.decided_by || null,
        ts: e.ts,
      });
    }
    if (e.protocol?.status === 'ERROR') {
      proto.push({
        seq: e.seq,
        method: e.method,
        code: e.protocol.error?.code,
        message: e.protocol.error?.message,
        hint: e.protocol.error?.hint || null,
        known_bad_name: e.protocol.known_bad_name || null,
        ts: e.ts,
      });
    }
  }

  // 协议版本与双方能力：架构基线里"现行生效的事实"要用
  const initReq = events.find((e) => e.method === 'initialize' && e.dir === 'client->agent');
  const initRes = events.find((e) => e.dir === 'agent->client' && e.kind === 'response' && e.parent_seq === initReq?.seq);

  // 挂载了哪些检查器、各自命中多少（含通过/不适用）—— 架构基线的"现行生效规则"要靠它
  const tally = new Map();
  for (const e of events) {
    if (!e.compliance_check) continue;
    const r = e.compliance_check;
    if (!tally.has(r.rule_id)) {
      tally.set(r.rule_id, { rule_id: r.rule_id, rule_source: r.rule_source, total: 0, passed: 0, failed: 0, skipped: 0, error: 0 });
    }
    const t = tally.get(r.rule_id);
    t.total++;
    const k = String(r.status || '').toLowerCase();
    if (k in t) t[k]++;
    if (r.rule_source) t.rule_source = r.rule_source;
  }

  return {
    rule_tally: [...tally.values()].sort((a, b) => b.total - a.total),
    heavy_files: [...heavy].map(([p, writes]) => {
      const norm = p.split('\\').join('/');           // 别用 path.dirname：payload 里已经是正斜杠，混用会因平台而异
      return {
        path: norm,
        // rel 是"去掉会话目录"的路径：看板按它聚合，否则同一份 sandbox 里的文件会在每个会话里各算一条，
        // 「承重墙」就变成"每会话各 1 次"的废话。真实项目文件本来就不带会话前缀，不受影响。
        rel: norm.replace(/^\.agents\/trace\/[^/]+\//, ''),
        dir: norm.replace(/\/[^/]*$/, ''),
        writes,
      };
    }).sort((a, b) => b.writes - a.writes || a.path.localeCompare(b.path)).slice(0, DIGEST_CAPS.heavy_files),
    compliance_failed: compliance.slice(0, DIGEST_CAPS.compliance_failed),
    denied: denied.slice(0, DIGEST_CAPS.denied),
    protocol_errors: proto.slice(0, DIGEST_CAPS.protocol_errors),
    capabilities: {
      protocol_version: initReq?.acp_message?.params?.protocolVersion ?? null,
      client: initReq?.acp_message?.params?.clientCapabilities ?? null,
      agent: initRes?.acp_message?.result?.agentCapabilities ?? null,
      agent_info: initRes?.acp_message?.result?.agentInfo ?? null,
    },
    truncated: {
      heavy_files: heavy.size > DIGEST_CAPS.heavy_files,
      compliance_failed: compliance.length > DIGEST_CAPS.compliance_failed,
      denied: denied.length > DIGEST_CAPS.denied,
      protocol_errors: proto.length > DIGEST_CAPS.protocol_errors,
    },
  };
}

function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 解析一篇决策笔记（AGENTS.md §4 骨架）。
 * 路径即状态即分类（{lifecycle}/{class}/yyyy-mm-dd-主题.md），标题取 `# Agent Note:` 行，
 * 缺行时用文件名兜底——树校验（compliance AGENT_NOTE_FORMAT）会拦不合格的，索引器不做第二套审判。
 * 看板的 source.js deriveIndexFromListing 里有一份同构解析（目录授权模式用），改字段两边要一起改。
 * @see [SPEC §5.8 看板入口索引与 digest schema](SPEC.md#58-看板入口索引与-digest-schema)
 */
export function parseNoteText(body, { status, category, id, file }) {
  const m = body.match(/^#\s*Agent Note:\s*(.+)\s*$/m);
  return {
    id,
    file,
    status,
    category,
    date: (id.match(/^\d{4}-\d{2}-\d{2}/) || [null])[0],
    title: m ? m[1].trim() : id,
    body: body.length > NOTE_BODY_LIMIT ? `${body.slice(0, NOTE_BODY_LIMIT)}\n…（笔记超长已截断）` : body,
    truncated: body.length > NOTE_BODY_LIMIT,
  };
}

/**
 * 收集 .agents/notes/ 全部笔记，算好「被引用」血缘。
 * 引用口径：其它笔记正文里出现本篇的文件名 stem（stem 含日期+主题，全库唯一，文本匹配即是相对链接的可靠代理）；
 * 按篇去重——同一篇反复链接只算一次，跟 pitfalls 的会话去重是同一个道理。
 */
export function parseNotes(cwd) {
  const root = path.join(cwd, NOTES_ROOT_REL);
  if (!fs.existsSync(root)) return { notes: [], truncated: false };
  const notes = [];
  let truncated = false;
  for (const status of NOTE_STATUSES) {
    const statusDir = path.join(root, status);
    if (!fs.existsSync(statusDir)) continue;
    for (const category of fs.readdirSync(statusDir, { withFileTypes: true })) {
      if (!category.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(statusDir, category.name)).sort()) {
        if (!f.endsWith('.md')) continue;
        if (notes.length >= NOTES_CAP) { truncated = true; break; }
        const id = f.replace(/\.md$/, '');
        const file = `${NOTES_ROOT_REL.split(path.sep).join('/')}/${status}/${category.name}/${f}`;
        const note = parseNoteText(fs.readFileSync(path.join(statusDir, category.name, f), 'utf8'), { status, category: category.name, id, file });
        // 被引用与外链都要在全集就位后才能算，先占位
        note.refd_by = [];
        note.links = [];
        notes.push(note);
      }
    }
  }
  for (const note of notes) {
    for (const other of notes) {
      if (other.id === note.id) continue;
      if (other.body.includes(note.id)) {
        note.refd_by.push(other.id);
        other.links.push(note.id);
      }
    }
  }
  for (const note of notes) note.refd_by.sort();
  notes.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.id.localeCompare(b.id));
  return { notes, truncated };
}

function listSessionDirs(traceRoot) {
  if (!fs.existsSync(traceRoot)) return [];
  return fs
    .readdirSync(traceRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(traceRoot, d.name, 'events.jsonl')))
    .map((d) => d.name)
    .sort();
}

function readEvents(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 跳过坏行，不让单条坏数据毁掉整个索引 */
    }
  }
  return out;
}

/** 从 events.jsonl 兜出 summary（summary.json 缺失时用） */
function deriveSummary(events) {
  const failed = events.filter((e) => e.compliance_check?.status === 'FAILED');
  const protoErr = events.filter((e) => e.protocol?.status === 'ERROR');
  const count = (m) => events.filter((e) => e.method === m).length;
  return {
    session_id: events[0]?.session_id ?? null,
    project_path: events[0]?.project_path ?? null,
    started_at: events[0]?.ts ?? null,
    ended_at: events.at(-1)?.ts ?? null,
    total_events: events.length,
    errors: { protocol: protoErr.length, compliance_failed: failed.length },
    counts: {
      permission_requests: count('session/request_permission'),
      write_attempts: count('fs/write_text_file'),
      write_applied: count('fs/write_applied'),
      terminal_attempts: count('terminal/create'),
      terminal_executed: count('terminal/created'),
    },
    failed_rules: [...new Set(failed.map((e) => e.compliance_check.rule_id))],
    protocol_error_methods: [...new Set(protoErr.map((e) => e.method))],
    derived: true,
  };
}

/**
 * 扫描 trace 根，产出索引对象（不写盘）
 * @returns {{index: object, sessions: Array<{meta: object, events: object[]}>}}
 */
export function collect({ cwd, traceRoot = path.join(cwd, TRACE_ROOT_REL), diffInlineMax = DIFF_INLINE_MAX }) {
  const dirNames = listSessionDirs(traceRoot);
  const sessions = [];
  const { notes, truncated: notesTruncated } = parseNotes(cwd);

  for (const name of dirNames) {
    const dir = path.join(traceRoot, name);
    const events = readEvents(path.join(dir, 'events.jsonl'));
    const summary = readJson(path.join(dir, 'summary.json')) ?? deriveSummary(events);
    const diffDir = path.join(dir, 'diffs');
    // diffNames 记全部、diffs 只装内联的部分：files.diffs 必须是全量清单，loadDiff 的按需回落才找得到
    const diffNames = [];
    const diffs = {};
    if (fs.existsSync(diffDir)) {
      let n = 0;
      for (const f of fs.readdirSync(diffDir).sort()) {
        if (!f.endsWith('.diff')) continue;
        diffNames.push(f);
        if (n >= diffInlineMax) continue;
        n++;
        const text = fs.readFileSync(path.join(diffDir, f), 'utf8');
        diffs[f] = text.length > DIFF_INLINE_LIMIT ? `${text.slice(0, DIFF_INLINE_LIMIT)}\n…（diff 超长已截断）` : text;
      }
    }
    const snapshots = fs.existsSync(path.join(dir, 'snapshots')) ? fs.readdirSync(path.join(dir, 'snapshots')).sort() : [];
    const rel = (p) => p.split(path.sep).join('/');

    sessions.push({
      meta: {
        session_id: summary.session_id ?? name,
        dir: name,
        project_path: summary.project_path ?? null,
        started_at: summary.started_at ?? null,
        ended_at: summary.ended_at ?? null,
        policy: summary.policy ?? null,
        stop_reason: summary.stop_reason ?? null,
        rules_source: summary.rules_source ?? null,
        rules_sha256_16: summary.rules_sha256_16 ?? null,
        counts: summary.counts ?? {},
        errors: summary.errors ?? { protocol: 0, compliance_failed: 0 },
        failed_rules: summary.failed_rules ?? [],
        protocol_error_methods: summary.protocol_error_methods ?? [],
        files: {
          events: rel(path.join(name, 'events.jsonl')),
          summary: rel(path.join(name, 'summary.json')),
          diffs: Object.fromEntries(diffNames.map((f) => [f, rel(path.join(name, 'diffs', f))])),
          snapshots: snapshots.map((s) => rel(path.join(name, 'snapshots', s))),
        },
        // diff 文本直接内联：远程模式下能少发一堆请求，本地模式也少读几次盘
        diffs_inline: diffs,
        diffs_inline_truncated: diffNames.length > Object.keys(diffs).length,
        events_count: events.length,
        // 跨会话聚合要用的摘要，宿主侧一次算好
        digest: buildDigest(events),
      },
      events,
    });
  }

  const index = {
    schema: 1,
    kind: 'spark-trace-index',
    project_path: cwd.split(path.sep).join('/'),
    generated_at: Date.now(),
    trace_root: TRACE_ROOT_REL.split(path.sep).join('/'),
    entry: 'index.json',
    notes,
    notes_truncated: notesTruncated,
    sessions: sessions.map((s) => s.meta).sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0)),
  };
  return { index, sessions };
}

/** 原子写：tmp + 同目录 rename。索引在宿主每轮会话结束都会重建（host.mjs），看板随时可能并发读，
 * 原地覆盖会让「会话刚跑完点开看板」恰好读到半截 JSON；rename 在同一目录内是原子替换。
 * @see [SPEC §5.8 看板入口索引与 digest schema](SPEC.md#58-看板入口索引与-digest-schema) */
function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function buildIndex({ cwd, traceRoot }) {
  const { index } = collect({ cwd, traceRoot });
  const file = path.join(cwd, TRACE_ROOT_REL, 'index.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(index, null, 2)}\n`);
  return { file, index };
}

/** 自包含单文件：事件与 diff 全部内联，可直接扔到任意静态托管上给看板的 HTTP 模式读 */
export function buildBundle({ cwd, traceRoot }) {
  // bundle 必须自包含：diff 全量内联，绕开 DIFF_INLINE_MAX（托管目录里没有旁挂的 diffs/ 可回落）
  const { index, sessions } = collect({ cwd, traceRoot, diffInlineMax: Infinity });
  const eventsByDir = new Map(sessions.map((s) => [s.meta.dir, s.events]));
  return {
    ...index,
    kind: 'spark-trace-bundle',
    entry: null,
    sessions: index.sessions.map((s) => ({ ...s, events: eventsByDir.get(s.dir) ?? [] })),
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────
function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const argOf = (flag, def) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : def;
  };
  const cwd = path.resolve(argOf('--cwd', process.cwd()));
  try {
    const { file, index } = buildIndex({ cwd });
    const bad = index.sessions.filter((s) => (s.errors?.protocol ?? 0) + (s.errors?.compliance_failed ?? 0) > 0).length;
    process.stdout.write(`索引已重建：${path.relative(cwd, file).split(path.sep).join('/')}\n`);
    process.stdout.write(`  会话 ${index.sessions.length} 个 · 其中有协议的或合规的错误 ${bad} 个 · 决策笔记 ${index.notes.length} 篇\n`);
    for (const s of index.sessions.slice(0, 5)) {
      process.stdout.write(
        `  · ${s.session_id}  事件 ${s.events_count} · 协议错误 ${s.errors.protocol} · 合规未过 ${s.errors.compliance_failed}\n`,
      );
    }
    if (index.sessions.length > 5) process.stdout.write(`  …另有 ${index.sessions.length - 5} 个\n`);

    const bundleOut = argOf('--bundle', null);
    if (bundleOut) {
      const bundle = buildBundle({ cwd });
      const out = path.resolve(bundleOut);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      writeAtomic(out, `${JSON.stringify(bundle)}\n`);
      const kb = (fs.statSync(out).size / 1024).toFixed(0);
      const bytes = (fs.statSync(file).size / 1024).toFixed(0);
      process.stdout.write(`单文件已导出：${path.relative(cwd, out).split(path.sep).join('/')}（${kb} KB，索引本身体积 ${bytes} KB）\n`);
      process.stdout.write('  这个文件可直接放到任意静态托管，看板选「HTTP 远程库」指向它即可。\n');
    }
  } catch (e) {
    process.stderr.write(`索引构建失败：${e.stack ?? e.message}\n`);
    process.exit(1);
  }
}
