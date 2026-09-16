#!/usr/bin/env node
// ACP 宿主（Host / Runner）最小闭环。
//
// 它做四件事，对应原设计文档里 Phase 1/2/3 的正确形态：
//   1) 以 stdio 拉起 agent 子进程，走 initialize -> session/new -> session/prompt 的完整生命周期
//      （原文档漏了后两步，所以它描述的流程根本跑不起来）；
//   2) 把仓库规则按协议允许的方式交进去 —— session/new 的 _meta + session/prompt 的 resource 内容块，
//      而不是文档里那个并不存在的「注入 initialize 的 System Prompt」；
//   3) 处理 agent 的反向 RPC（session/request_permission / fs.* / terminal.*），
//      有副作用的一律过审批闸门，未知方法立刻回 JSON-RPC 错误码；
//   4) 逐条落盘成 events.jsonl（带 seq 与 parent_seq 血缘），实时通道广播给看板。
//
// 用法：
//   node host.mjs --mock --policy allow
//   node host.mjs --mock --policy ask --ws-port 9001        # 配合 approver.mjs
//   node host.mjs --agent "claude-code-acp" --cwd /path/to/repo --prompt "..."
//   node host.mjs --mock --preflight hosts-switcher/0.1.0
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { TraceWriter, newSessionId } from './trace.mjs';
import { evaluateWrite, runPreflight, classifyRisk, RULES } from './compliance.mjs';
import { unifiedDiff, countLines } from './diff.mjs';
import { startWsServer } from './ws.mjs';
import { buildIndex } from './trace-index.mjs';
import { scan as scanAnchors } from './check-trace-anchors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REQUEST_TIMEOUT_MS = 120_000;

// ── 参数 ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { policy: null, wsPort: 9001, approveTimeoutMs: 60_000, waitDashboardMs: 0, traceContentLimit: 4000, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--mock': out.mock = true; break;
      case '--agent': out.agent = next(); break;
      case '--proxy': out.proxy = true; break;
      case '--cwd': out.cwd = next(); break;
      case '--prompt': out.prompt = next(); break;
      case '--policy': out.policy = next(); break;
      case '--ws-port': out.wsPort = Number(next()); break;
      case '--token': out.token = next(); break;
      case '--approve-timeout-ms': out.approveTimeoutMs = Number(next()); break;
      case '--wait-dashboard-ms': out.waitDashboardMs = Number(next()); break;
      case '--trace-content-limit': out.traceContentLimit = Number(next()); break;
      case '--rules': out.rules = next(); break;
      case '--preflight': out.preflight = next(); break;
      case '--preflight-anchors': out.preflightAnchors = true; break;
      case '--quiet': out.quiet = true; break;
      case '--help': case '-h': out.help = true; break;
      default: throw new Error(`未知参数：${a}`);
    }
  }
  return out;
}

const USAGE = `ACP 宿主最小闭环

  --mock                   用内置的 mock agent 跑（离线可测，不需要任何真 CLI）
  --agent "<命令>"          要拉起的 ACP agent 命令（二选一）
  --proxy                  代理模式：对外伪装 agent（外层 client 的 stdio 直连本进程），对内拉起 --agent；
                            双向转发双向落盘，反向请求就地处理不外泄；默认 --policy allow（纯记录）
  --cwd <目录>              目标项目根（默认当前目录）
  --prompt <文本>           本轮指令
  --policy allow|deny|ask   有副作用调用的审批策略（默认 ask）
  --ws-port <端口>          实时通道端口，0=随机，-1=关闭（默认 9001）
  --token <字符串>          实时通道鉴权 token（默认随机，会打印出来）
  --approve-timeout-ms <n>  审批超时，超时按拒绝处理（默认 60000）
  --wait-dashboard-ms <n>   policy=ask 时先等看板连上再开跑（默认 0，不等）
  --trace-content-limit <n> 入站写盘内容在 trace 里保留的字符数（默认 4000，0=不限）
                            完整内容始终在 snapshots/ 里，trace 只做体积控制并留截断标记
  --rules <文件>            规则文件，默认 <cwd>/AGENTS.md
  --preflight <插件版本目录> 跑发布物完整性 N-1 核对
  --preflight-anchors       全仓扫描代码里的 @see / @trace 反向锚点，失效即报错
                             （写 .js/.mjs 时也会自动查那一个文件，这里是不依赖 agent 动作的全量兜底）
  --quiet                   不放实时输出，只落盘
`;

// ── 文件系统边界 ──────────────────────────────────────────────────────────
function inside(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args.mock && !args.agent) {
    process.stdout.write(USAGE);
    throw new Error('必须给 --mock 或 --agent');
  }
  // 代理模式默认 allow（纯记录）：外层 client 的 stdin 是协议管道没有 TTY，ask 在无看板时按安全默认全拒，agent 直接废
  // @see [SPEC §Phase 0 代理模式](SPEC.md#phase-0--代理模式--proxy直开会话上链路)
  // @see [宿主代理模式](../notes/implemented/architecture/2026-09-16-宿主代理模式.md)
  if (!args.policy) args.policy = args.proxy ? 'allow' : 'ask';
  if (!['allow', 'deny', 'ask'].includes(args.policy)) throw new Error(`--policy 只能是 allow|deny|ask`);

  const cwd = path.resolve(args.cwd ?? process.cwd());
  const prompt = args.prompt ?? '请按 AGENTS.md 的规则检查插件页面，需要提取的就提取，并跑一遍自检。';
  const rulesFile = path.resolve(args.rules ?? path.join(cwd, 'AGENTS.md'));
  const token = args.token ?? crypto.randomBytes(12).toString('hex');
  const methodTable = JSON.parse(fs.readFileSync(path.join(HERE, 'acp-methods.json'), 'utf8'));

  const sessionId = newSessionId();
  const traceDir = path.join(cwd, '.agents', 'trace', sessionId);
  const traceRelPrefix = `${path.relative(cwd, traceDir).split(path.sep).join('/')}/`;
  const sandbox = path.join(traceDir, 'sandbox');
  const snapshots = path.join(traceDir, 'snapshots');
  const diffs = path.join(traceDir, 'diffs');
  for (const d of [sandbox, snapshots, diffs]) fs.mkdirSync(d, { recursive: true });

  const trace = new TraceWriter({ dir: traceDir, sessionId, projectPath: cwd, methodTable });
  // 代理模式的 stdout 是对外的 ACP 协议通道，任何非 JSON 行都是协议损坏，人话日志一律走 stderr
  // @see [SPEC §Phase 0 代理模式](SPEC.md#phase-0--代理模式--proxy直开会话上链路)
  const say = (...a) => {
    if (!args.quiet) (args.proxy ? process.stderr : process.stdout).write(`${a.join(' ')}\n`);
  };
  // 汇总与核对结果属于「结论」，--quiet 只静默逐条流水，不静默结论
  const report = (...a) => (args.proxy ? process.stderr : process.stdout).write(`${a.join(' ')}\n`);

  // ── 实时通道 ────────────────────────────────────────────────────────────
  let ws = null;
  const pendingApprovals = new Map();
  if (args.wsPort !== -1) {
    try {
      ws = await startWsServer({
        port: args.wsPort,
        token,
        onClientCount: (n) => trace.mark({ name: 'ws/client_count', payload: { clients: n } }),
        onMessage: (msg) => {
          if (msg?.type === 'permission_decision' && pendingApprovals.has(msg.rpc_id)) {
            trace.mark({ name: 'ws/decision_received', payload: msg });
            pendingApprovals.get(msg.rpc_id)(msg.optionId ?? null);
          } else {
            trace.mark({ name: 'ws/unknown_message', payload: msg });
          }
        },
      });
      trace.attachBroadcast((rec) => ws.broadcast({ type: 'TRACE_EVENT', event: rec }));
      say(`实时通道 : ${ws.url}`);
    } catch (e) {
      trace.mark({ name: 'ws/start_failed', payload: { error: String(e.message) } });
      say(`实时通道启动失败（${e.message}），仅走归档通道`);
    }
  }
  say(`会话      : ${sessionId}`);
  say(`目标项目  : ${cwd}`);
  say(`追溯目录  : ${path.relative(cwd, traceDir)}`);
  say(`审批策略  : ${args.policy}`);
  say(`已挂检查器: ${RULES.map((r) => r.rule_id).join(', ')}`);
  say('');

  // ── 审批闸门 ────────────────────────────────────────────────────────────
  const pickOption = (options, mode) => {
    if (!Array.isArray(options) || !options.length) return null;
    const hit = options.find((o) => String(o.kind ?? o.optionId ?? '').startsWith(mode));
    if (hit) return hit.optionId;
    return mode === 'allow' ? options[0].optionId : options[options.length - 1].optionId;
  };

  async function askDashboard({ rpcId, method, params, risk, reason }) {
    if (!ws || ws.clientCount() === 0) {
      if (process.stdin.isTTY && !args.quiet) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ans = await new Promise((r) =>
          rl.question(`[审批] ${risk} ${reason}\n       允许吗？(y/N) `, r),
        );
        rl.close();
        return { optionId: /^y/i.test(ans.trim()) ? pickOption(params?.options, 'allow') ?? '__allow__' : null, by: 'tty' };
      }
      return { optionId: null, by: 'no_client' };
    }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(rpcId);
        resolve({ optionId: null, by: 'timeout' });
      }, args.approveTimeoutMs);
      pendingApprovals.set(rpcId, (optionId) => {
        clearTimeout(timer);
        pendingApprovals.delete(rpcId);
        resolve({ optionId, by: 'dashboard' });
      });
      ws.broadcast({
        type: 'PERMISSION_REQUEST',
        rpc_id: rpcId,
        method,
        risk_level: risk,
        reason,
        timeout_ms: args.approveTimeoutMs,
        expires_at: Date.now() + args.approveTimeoutMs,
        options: params?.options ?? null,
      });
    });
  }

  /**
   * 副作用调用的统一闸门：先记录 approval/request，再按策略（或看板）决定，最后记录 approval/decision。
   * 策略为 ask 时的取值顺序是「看板 → 交互式终端 → 默认拒绝」，**超时也按拒绝**。
   *
   * @see [SPEC §4.3 审批流程与默认值](SPEC.md#43-审批流程与默认值)
   * @trace s_20260915-160302_1908bc#34 实测：看板点「拒绝」后，那个文件在磁盘上确实不存在（写盘 尝试 7 · 落盘 4 · 被拒 3）
   */
  async function gate({ rpcId, method, params, parentSeq }) {
    const { risk, reason } = classifyRisk(method, params);
    const t0 = Date.now();
    trace.mark({
      name: 'approval/request',
      parentSeq,
      turnSeq: currentTurnSeq,
      payload: { rpc_id: rpcId, method, risk_level: risk, reason, policy: args.policy, options: params?.options ?? null },
      extra: { risk_level: risk },
    });

    let optionId = null;
    let by = `policy:${args.policy}`;
    if (args.policy === 'allow') {
      optionId = pickOption(params?.options, 'allow') ?? '__allow__';
    } else if (args.policy === 'deny') {
      optionId = null;
    } else {
      const r = await askDashboard({ rpcId, method, params, risk, reason });
      optionId = r.optionId;
      by = r.by;
    }

    const approved = Boolean(optionId) && (optionId === '__allow__' || String(optionId).startsWith('allow'));
    trace.mark({
      name: 'approval/decision',
      parentSeq,
      turnSeq: currentTurnSeq,
      payload: { rpc_id: rpcId, method, option_id: optionId, approved, decided_by: by, latency_ms: Date.now() - t0 },
    });
    say(`  [审批] ${approved ? '放行' : '拒绝'} ${method}（${risk} · ${by}）`);
    return { approved, optionId, risk, reason, by };
  }

  // ── 与 agent 的 JSON-RPC ────────────────────────────────────────────────
  const agentArgv = args.mock
    ? { cmd: process.execPath, argv: [path.join(HERE, 'mock-agent.mjs')], shell: false }
    : { cmd: args.agent, argv: [], shell: true };

  const child = spawn(agentArgv.cmd, agentArgv.argv, {
    cwd,
    shell: agentArgv.shell,
    stdio: ['pipe', 'pipe', 'pipe'],
    // env 是 agent 判「自己在不在宿主链路上」的唯一机械通道（_meta.sparkTrace 只到协议层，agent CLI 多不透给模型），条件式锚点靠它
    // @see [SPEC §5.6 反向锚点](SPEC.md#56-反向锚点代码--追溯记录)
    // @see [条件式反向锚点](../notes/implemented/process/2026-09-16-条件式反向锚点.md)
    env: { ...process.env, SPARK_TRACE_SESSION: sessionId, SPARK_TRACE_DIR: traceDir },
    windowsHide: true,
  });
  trace.mark({ name: 'host/spawn', payload: { command: args.mock ? `${process.execPath} mock-agent.mjs` : args.agent, cwd, pid: child.pid } });

  let nextRpcId = 1;
  let sessionIdRemote = null;
  let currentTurnSeq = null;
  const inflight = new Map();

  const write = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

  function sendRequest(method, params, { silent = false } = {}) {
    const id = nextRpcId++;
    const message = { jsonrpc: '2.0', id, method, params };
    const rec = trace.acp({ dir: 'client->agent', message, turnSeq: currentTurnSeq });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (inflight.delete(id)) reject(new Error(`agent 未在 ${REQUEST_TIMEOUT_MS}ms 内响应 ${method}`));
      }, REQUEST_TIMEOUT_MS);
      inflight.set(id, {
        method,
        seq: rec.seq,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      write(message);
      if (!silent) say(`  → ${method}`);
    });
  }
  function sendNotification(method, params) {
    const message = { jsonrpc: '2.0', method, params };
    trace.acp({ dir: 'client->agent', message, turnSeq: currentTurnSeq });
    write(message);
  }
  function sendResult(id, result, parentSeq) {
    const message = { jsonrpc: '2.0', id, result };
    trace.acp({ dir: 'client->agent', message, parentSeq, turnSeq: currentTurnSeq });
    write(message);
  }
  function sendError(id, code, message, data, parentSeq) {
    const payload = { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
    trace.acp({ dir: 'client->agent', message: payload, parentSeq, turnSeq: currentTurnSeq });
    write(payload);
  }

  // 终端句柄
  const terminals = new Map();
  let terminalSeq = 0;

  async function handleReverseRequest(msg, seq) {
    const spec = methodTable.methods[msg.method];
    const isKnown = spec && spec.dir === 'agent->client' && spec.kind === 'request';
    if (!isKnown) {
      // 关键行为：绝不静默挂起
      const hint = methodTable.rejected[msg.method] ?? 'ACP 未登记此方法名';
      trace.mark({ name: 'protocol/rejected_unknown_method', parentSeq: seq, turnSeq: currentTurnSeq, payload: { method: msg.method, hint } });
      say(`  ✗ 拒绝未登记方法 ${msg.method}（回 -32601，不挂起）`);
      sendError(msg.id, -32601, `Method not found: ${msg.method}`, { hint }, seq);
      return;
    }

    const params = msg.params ?? {};
    try {
      switch (msg.method) {
        case 'session/request_permission': {
          const g = await gate({ rpcId: msg.id, method: msg.method, params, parentSeq: seq });
          if (params.options?.length) {
            sendResult(msg.id, { outcome: g.optionId ? { outcome: 'selected', optionId: g.optionId } : { outcome: 'cancelled' } }, seq);
          } else {
            sendResult(msg.id, { outcome: { outcome: g.approved ? 'selected' : 'cancelled' } }, seq);
          }
          return;
        }

        case 'fs/read_text_file': {
          const abs = path.resolve(String(params.path ?? ''));
          if (!inside(cwd, abs)) {
            sendError(msg.id, -32001, `拒绝读取工作区之外的路径：${abs}`, null, seq);
            return;
          }
          if (!fs.existsSync(abs)) {
            sendError(msg.id, -32002, `文件不存在：${abs}`, null, seq);
            return;
          }
          const text = fs.readFileSync(abs, 'utf8');
          const lines = text.split('\n');
          const start = params.line ? Math.max(0, Number(params.line) - 1) : 0;
          const end = params.limit ? start + Number(params.limit) : lines.length;
          sendResult(msg.id, { content: lines.slice(start, end).join('\n') }, seq);
          return;
        }

        case 'fs/write_text_file': {
          const abs = path.resolve(String(params.path ?? ''));
          const rel = path.relative(cwd, abs).split(path.sep).join('/');
          if (!inside(cwd, abs)) {
            sendError(msg.id, -32001, `拒绝写入工作区之外的路径：${abs}`, null, seq);
            return;
          }
          if (/(^|\/)\.git\//.test(rel) || rel.startsWith('.agents/runner/')) {
            sendError(msg.id, -32001, `拒绝写入受保护路径：${rel}`, null, seq);
            return;
          }
          const g = await gate({ rpcId: msg.id, method: msg.method, params, parentSeq: seq });
          if (!g.approved) {
            sendError(msg.id, -32001, `审批未通过，写入被拒：${rel}`, { decided_by: g.by }, seq);
            return;
          }
          const existed = fs.existsSync(abs);
          const before = existed ? fs.readFileSync(abs, 'utf8') : '';
          const content = String(params.content ?? '');
          // 快照/diff 的文件名：去掉本会话目录前缀，免得编出一长串 .agents__trace__s_xxx__
          const slug = (rel.startsWith(traceRelPrefix) ? rel.slice(traceRelPrefix.length) : rel).replace(/[\\/]/g, '__');
          if (existed) fs.writeFileSync(path.join(snapshots, `${slug}.before`), before);
          fs.writeFileSync(path.join(snapshots, `${slug}.after`), content);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content, 'utf8');

          const d = unifiedDiff(before, content, { oldLabel: `a/${rel}`, newLabel: `b/${rel}` });
          fs.writeFileSync(path.join(diffs, `${slug}.diff`), d.text ? `${d.text}\n` : '');
          trace.mark({
            name: 'fs/write_applied',
            parentSeq: seq,
            turnSeq: currentTurnSeq,
            payload: { path: rel, created: !existed, before_lines: countLines(before), after_lines: countLines(content), diff_file: `diffs/${slug}.diff` },
          });
          for (const record of evaluateWrite({ absPath: abs, content, cwd, before: existed ? before : '' })) {
            trace.compliance({ parentSeq: seq, record });
            const glyph = record.status === 'PASSED' ? '✓' : record.status === 'SKIPPED' ? '·' : record.status === 'WARN' ? '⚠' : '✗';
            say(`    ${glyph} ${record.rule_id} ${record.message}`);
          }
          // 标准响应体只带 _meta 扩展 —— 协议允许的扩展方式，不发明顶层字段
          sendResult(msg.id, { _meta: { diff: { added: d.added, removed: d.removed, hunks: d.hunks.length }, created: !existed, diff_file: `diffs/${slug}.diff` } }, seq);
          return;
        }

        case 'terminal/create': {
          const command = Array.isArray(params.command) ? params.command : [String(params.command ?? '')];
          const runCwd = params.cwd ? path.resolve(String(params.cwd)) : cwd;
          if (!inside(cwd, runCwd)) {
            sendError(msg.id, -32001, `拒绝在工作区之外执行：${runCwd}`, null, seq);
            return;
          }
          const g = await gate({ rpcId: msg.id, method: msg.method, params, parentSeq: seq });
          if (!g.approved) {
            sendError(msg.id, -32001, `审批未通过，命令未执行：${command.join(' ')}`, { decided_by: g.by }, seq);
            return;
          }
          const termId = `term_${++terminalSeq}`;
          const proc = spawn(command[0], command.slice(1), { cwd: runCwd, env: process.env, windowsHide: true });
          const entry = { proc, out: '', err: '', exitCode: null, signal: null };
          entry.exited = new Promise((resolve) => {
            proc.on('close', (code, signal) => {
              entry.exitCode = code;
              entry.signal = signal;
              resolve();
            });
            proc.on('error', (e) => {
              entry.err += `\n[spawn error] ${e.message}`;
              entry.exitCode = -1;
              resolve();
            });
          });
          proc.stdout.on('data', (b) => (entry.out += b.toString('utf8')));
          proc.stderr.on('data', (b) => (entry.err += b.toString('utf8')));
          terminals.set(termId, entry);
          trace.mark({ name: 'terminal/created', parentSeq: seq, turnSeq: currentTurnSeq, payload: { terminal_id: termId, command, cwd: runCwd, pid: proc.pid } });
          sendResult(msg.id, { terminalId: termId }, seq);
          return;
        }

        case 'terminal/wait_for_exit': {
          const entry = terminals.get(String(params.terminalId));
          if (!entry) return sendError(msg.id, -32602, `未知 terminalId：${params.terminalId}`, null, seq);
          await entry.exited;
          sendResult(msg.id, { exitCode: entry.exitCode, signal: entry.signal }, seq);
          return;
        }

        case 'terminal/output': {
          const entry = terminals.get(String(params.terminalId));
          if (!entry) return sendError(msg.id, -32602, `未知 terminalId：${params.terminalId}`, null, seq);
          const output = (entry.out + entry.err).slice(-20_000);
          sendResult(
            msg.id,
            { output, truncated: output.length >= 20_000, ...(entry.exitCode === null ? {} : { exitStatus: { exitCode: entry.exitCode } }) },
            seq,
          );
          return;
        }

        case 'terminal/kill': {
          const entry = terminals.get(String(params.terminalId));
          if (entry && entry.exitCode === null) entry.proc.kill();
          sendResult(msg.id, {}, seq);
          return;
        }

        case 'terminal/release': {
          terminals.delete(String(params.terminalId));
          sendResult(msg.id, {}, seq);
          return;
        }

        default:
          sendError(msg.id, -32601, `宿主未实现：${msg.method}`, null, seq);
      }
    } catch (e) {
      sendError(msg.id, -32603, `宿主内部错误：${e.message}`, null, seq);
    }
  }

  function handleNotification(msg, seq) {
    if (msg.method !== 'session/update') return;
    const u = msg.params?.update ?? {};
    if (u.kind === 'agent_thought_chunk') say(`  · 思考：${String(u.content?.text ?? '').slice(0, 90)}`);
    else if (u.kind === 'agent_message_chunk') say(`  · 回答：${String(u.content?.text ?? '').slice(0, 160).replace(/\n/g, '\n           ')}`);
    else if (u.kind === 'tool_call' || u.kind === 'tool_call_update') say(`  · 工具：${u.title ?? u.toolCallId ?? ''}`);
    else say(`  · ${u.kind ?? 'unknown update'}`);
  }

  /**
   * trace 体积控制：写盘内容可能很大（整份 HTML），若原样进 events.jsonl，
   * 看板读一次就要吞几百 KB。这里只截断"记录"，**不截断"执行"** —— 落盘用的是原始 msg，
   * 完整内容始终留在 snapshots/ 里，并在事件上留 trace_normalized 标记说明截了多少。
   *
   * @see [SPEC §5.1 事件 envelop](SPEC.md#51-事件-envelop权威版本) —— trace_normalized 字段
   * @trace s_20260915-180105_c25f08#19 实测：9788 字符被截到 4000，该事件 events.jsonl 从 110KB 降到 63KB
   */
  const TRACE_CONTENT_LIMIT = args.traceContentLimit;
  function normalizeForTrace(msg) {
    const p = msg?.params;
    if (TRACE_CONTENT_LIMIT > 0 && msg?.method === 'fs/write_text_file' && typeof p?.content === 'string' && p.content.length > TRACE_CONTENT_LIMIT) {
      return {
        recorded: { ...msg, params: { ...p, content: `${p.content.slice(0, TRACE_CONTENT_LIMIT)}\n…（此处已截断）` } },
        note: {
          field: 'acp_message.params.content',
          original_chars: p.content.length,
          kept_chars: TRACE_CONTENT_LIMIT,
          reason: '追溯体积控制；完整内容见 snapshots/',
        },
      };
    }
    return { recorded: msg, note: null };
  }

  let stdoutBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        trace.mark({ name: 'agent/non_json_stdout', payload: { line: line.slice(0, 400) } });
        continue;
      }
      const isResponse = msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined);
      const parentSeq = isResponse ? (inflight.get(msg.id)?.seq ?? null) : currentTurnSeq;
      const { recorded, note } = normalizeForTrace(msg);
      const rec = trace.acp({ dir: 'agent->client', message: recorded, parentSeq, turnSeq: currentTurnSeq, extra: note ? { trace_normalized: note } : {} });
      if (isResponse) {
        const p = inflight.get(msg.id);
        if (p) {
          inflight.delete(msg.id);
          if (msg.error) p.reject(new Error(`${msg.error.code} ${msg.error.message}`));
          else p.resolve(msg.result);
        }
        if (args.proxy) process.stdout.write(`${line}\n`);
        continue;
      }
      if (msg.method && msg.id !== undefined) {
        void handleReverseRequest(msg, rec.seq);
        continue;
      }
      handleNotification(msg, rec.seq);
      if (args.proxy) process.stdout.write(`${line}\n`);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (b) => {
    for (const line of String(b).split('\n').filter(Boolean)) say(`  [agent stderr] ${line}`);
  });
  child.on('close', (code) => trace.mark({ name: 'host/agent_exit', payload: { code } }));

  // ── 生命周期 ────────────────────────────────────────────────────────────
  let exitCode = 0;
  let rulesText = null;
  let rulesFingerprint = null;
  const rulesRel = path.relative(cwd, rulesFile).split(path.sep).join('/');

  if (args.proxy) {
    /* 代理模式：宿主对外伪装 agent（外层 client 的 stdio 直连本进程），对内仍以 client 拉起 --agent，
       只做透明转发 + 双向落盘。唯一的加料点是 session/new 注入 _meta.sparkTrace —— agent 拿到
       trace 坐标才能挂 @trace 锚。反向请求（权限/fs/terminal）就地处理不外泄。 */
    // @see [SPEC §Phase 0 代理模式](SPEC.md#phase-0--代理模式--proxy直开会话上链路)
    // @see [宿主代理模式](../notes/implemented/architecture/2026-09-16-宿主代理模式.md)
    if (fs.existsSync(rulesFile)) {
      rulesText = fs.readFileSync(rulesFile, 'utf8');
      rulesFingerprint = crypto.createHash('sha256').update(rulesText).digest('hex').slice(0, 16);
    }
    trace.mark({ name: 'rules/loaded', payload: { source: rulesRel, sha256_16: rulesFingerprint, bytes: rulesText?.length ?? 0, mode: 'proxy' } });
    trace.mark({ name: 'proxy/start', payload: { agent: args.agent ?? 'mock', cwd, policy: args.policy } });

    let outerBuf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      outerBuf += chunk;
      let idx;
      while ((idx = outerBuf.indexOf('\n')) >= 0) {
        const line = outerBuf.slice(0, idx).trim();
        outerBuf = outerBuf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          trace.mark({ name: 'proxy/non_json_stdin', payload: { line: line.slice(0, 400) } });
          continue;
        }
        if (msg.method === 'session/new' && msg.params) {
          // 透明代理唯一的加料点：注入 _meta.sparkTrace，agent 拿到锚点坐标
          // @see [SPEC §Phase 0 代理模式](SPEC.md#phase-0--代理模式--proxy直开会话上链路)
          msg.params = {
            ...msg.params,
            _meta: { ...(msg.params._meta ?? {}), sparkTrace: { sandbox, trace_dir: traceDir, rules_source: rulesRel, rules_sha256_16: rulesFingerprint } },
          };
          trace.mark({ name: 'proxy/session_new_mutated', payload: { injected: '_meta.sparkTrace' } });
        }
        const rec = trace.acp({ dir: 'client->agent', message: msg, turnSeq: currentTurnSeq });
        if (msg.method === 'session/prompt' && msg.id !== undefined) currentTurnSeq = rec.seq;
        if (msg.id !== undefined && msg.method) inflight.set(msg.id, { method: msg.method, seq: rec.seq, resolve: () => {}, reject: () => {} });
        write(msg);
        say(`  ← ${msg.method ?? '(response)'}`);
      }
    });
    process.stdin.on('end', () => trace.mark({ name: 'proxy/client_disconnected' }));

    // 等外层 client 断开、agent 退出或 SIGINT，再走统一收尾
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      process.stdin.on('end', finish);
      child.on('close', finish);
      process.on('SIGINT', () => {
        trace.mark({ name: 'proxy/sigint' });
        finish();
      });
    });
    say('── 代理会话结束（外层 client 断开 / agent 退出 / SIGINT）');
  }

  if (!args.proxy) {
    try {
      say('── Phase 1: initialize（能力协商）');
      const init = await sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: { create: true, output: true, waitForExit: true, kill: true, release: true },
        },
        clientInfo: { name: 'spark acp host', version: '0.1.0' },
      });
      const caps = init?.agentCapabilities ?? {};
      say(`  ✓ 握手完成：协议版本 ${init?.protocolVersion}，能力 ${JSON.stringify(caps)}`);
      if (!caps.promptCapabilities?.embeddedContext) {
        say('  ! agent 未声明 embeddedContext：规则无法以 resource 块注入，只能退化为把规则拼进文本块');
      }

      say('── Phase 2: session/new（规则与上下文同步）');
      if (fs.existsSync(rulesFile)) {
        rulesText = fs.readFileSync(rulesFile, 'utf8');
        rulesFingerprint = crypto.createHash('sha256').update(rulesText).digest('hex').slice(0, 16);
      } else {
        say(`  ! 没找到规则文件 ${rulesFile}`);
      }
      const newSession = await sendRequest('session/new', {
        cwd,
        mcpServers: [],
        // 规则用 _meta 传（协议允许的扩展位），不假装能塞进 initialize
        _meta: {
          sparkTrace: {
            sandbox,
            trace_dir: traceDir,
            rules_source: path.relative(cwd, rulesFile).split(path.sep).join('/'),
            rules_sha256_16: rulesFingerprint,
          },
        },
      });
      sessionIdRemote = newSession?.sessionId ?? null;
      say(`  ✓ sessionId = ${sessionIdRemote}`);
      trace.mark({ name: 'rules/loaded', payload: { source: path.relative(cwd, rulesFile), sha256_16: rulesFingerprint, bytes: rulesText?.length ?? 0 } });

      say('── Phase 3: session/prompt（指令分发 + 副作用拦截）');
      if (args.waitDashboardMs > 0 && ws && ws.clientCount() === 0) {
        say(`  等待看板连接实时通道（最多 ${args.waitDashboardMs}ms）…`);
        const deadline = Date.now() + args.waitDashboardMs;
        while (Date.now() < deadline && ws.clientCount() === 0) {
          await new Promise((r) => setTimeout(r, 100));
        }
        const n = ws.clientCount();
        trace.mark({ name: 'ws/dashboard_ready', payload: { clients: n, waited_ms: args.waitDashboardMs } });
        say(n > 0 ? `  ✓ 看板已连接（${n} 个），开始执行` : '  ! 超时无人连接：审批将按默认拒绝处理（安全默认）');
      }
      const content = [];
      if (rulesText) {
        content.push({
          type: 'resource',
          resource: { uri: `file:///${rulesFile.replace(/\\/g, '/')}`, mimeType: 'text/markdown', text: rulesText },
        });
      }
      content.push({ type: 'text', text: prompt });
      const turnPromise = sendRequest('session/prompt', { sessionId: sessionIdRemote, content }, { silent: true });
      currentTurnSeq = trace.events[trace.events.length - 1]?.seq ?? null;
      const turnResult = await turnPromise;
      say(`  ✓ 本轮结束：stopReason = ${turnResult?.stopReason}`);
    } catch (e) {
      say(`!! 生命周期中断：${e.message}`);
      trace.mark({ name: 'host/lifecycle_error', payload: { error: e.message } });
      exitCode = 2;
    }
  }

  // ── 收尾 ────────────────────────────────────────────────────────────────
  if (args.preflight) {
    report(`── 发布物完整性核对：${args.preflight}`);
    const record = runPreflight({ pluginDir: args.preflight, cwd });
    trace.compliance({ parentSeq: null, record });
    report(`  ${record.status === 'PASSED' ? '✓' : '✗'} ${record.message}`);
    if (record.details?.manifest_entries !== undefined) {
      report(`    git 追踪 ${record.details.git_tracked} 个 · 减 signature.json 自身 = ${record.details.minus_signature_self} · 清单 ${record.details.manifest_entries} 条`);
    }
  }

  if (args.preflightAnchors) {
    report('── 反向锚点全仓扫描（代码 → 追溯记录）');
    try {
      const res = scanAnchors({ cwd });
      const detail = {
        files: res.files,
        anchors: res.anchors,
        resolved: res.anchors - res.failures.length - res.skipped.length,
        skipped: res.skipped.length,
        failures: res.failures.map((f) => ({ file: f.file, line: f.line, raw: f.raw, reason: f.reason })),
      };
      const record = res.failures.length
        ? {
            rule_id: 'TRACE_NOTE_ANCHORS',
            rule_source: 'AGENTS.md §1 ACP 规范（留痕要求）+ check-trace-anchors.mjs 契约',
            status: 'FAILED',
            message: `${res.failures.length} 个锚点失效：${res.failures.slice(0, 3).map((f) => `${f.file}:${f.line}`).join(' · ')}`,
            details: detail,
          }
        : {
            rule_id: 'TRACE_NOTE_ANCHORS',
            rule_source: 'AGENTS.md §1 ACP 规范（留痕要求）+ check-trace-anchors.mjs 契约',
            status: 'PASSED',
            message: `${res.anchors} 个锚点全部解析${res.skipped.length ? `（${res.skipped.length} 个追溯坐标因会话不在本机而跳过）` : ''}`,
            details: detail,
          };
      trace.compliance({ parentSeq: null, record });
      report(`  ${record.status === 'PASSED' ? '✓' : '✗'} ${record.message}`);
      report(`    扫描 ${res.files} 个文件 · 通过 ${detail.resolved} · 跳过 ${detail.skipped} · 失效 ${res.failures.length}`);
      for (const f of res.failures.slice(0, 5)) report(`    ✗ ${f.file}:${f.line} ${f.raw} → ${f.reason}`);
    } catch (e) {
      const record = {
        rule_id: 'TRACE_NOTE_ANCHORS',
        rule_source: 'AGENTS.md §1 ACP 规范（留痕要求）',
        status: 'ERROR',
        message: `锚点扫描自身失败：${e.message}`,
        details: {},
      };
      trace.compliance({ parentSeq: null, record });
      report(`  ✗ ${record.message}`);
    }
  }

  const summary = trace.writeSummary({
    stop_reason: exitCode === 0 ? 'end_turn' : 'host_error',
    policy: args.policy,
    rules_source: rulesRel,
    rules_sha256_16: rulesFingerprint,
  });
  // 重建看板入口索引：spark.fs 没有目录列举能力，看板只能按索引去找会话
  let indexInfo = null;
  try {
    const { file: indexFile, index } = buildIndex({ cwd });
    indexInfo = { file: path.relative(cwd, indexFile).split(path.sep).join('/'), sessions: index.sessions.length };
    trace.mark({ name: 'index/rebuilt', payload: indexInfo });
  } catch (e) {
    trace.mark({ name: 'index/rebuild_failed', payload: { error: String(e.message) } });
  }

  if (ws) ws.close();
  try {
    child.kill();
  } catch {
    /* ignore */
  }

  report('');
  report('── 归档结果 ─────────────────────────────────────────────────');
  report(`事件总数    : ${summary.total_events}`);
  report(`协议错误    : ${summary.errors.protocol} 条${summary.protocol_error_methods.length ? `（${summary.protocol_error_methods.join(', ')}）` : ''}`);
  report(`合规未通过  : ${summary.errors.compliance_failed} 条${summary.failed_rules.length ? `（${summary.failed_rules.join(', ')}）` : ''}`);
  report(`审批拦截    : ${summary.counts.write_attempts + summary.counts.terminal_attempts} 次副作用尝试，全部过闸`);
  report(`写盘        : 尝试 ${summary.counts.write_attempts} · 落盘 ${summary.counts.write_applied} · 被拒 ${summary.counts.write_attempts - summary.counts.write_applied}`);
  report(`命令        : 尝试 ${summary.counts.terminal_attempts} · 执行 ${summary.counts.terminal_executed}`);
  report(`追溯文件    : ${path.relative(cwd, trace.file)}`);
  report(`看板索引    : ${indexInfo ? `${indexInfo.file}（${indexInfo.sessions} 个会话）` : '未生成'}`);
  report(`快照 / Diff : ${path.relative(cwd, snapshots)} / ${path.relative(cwd, diffs)}`);
  report('');
  report(`回看这一轮：node ${path.relative(cwd, path.join(HERE, 'trace-report.mjs')).split(path.sep).join('/')} ${path.relative(cwd, traceDir)}`);
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`宿主启动失败：${e.stack ?? e.message}\n`);
    process.exit(1);
  });
