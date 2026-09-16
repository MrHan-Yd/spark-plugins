// 追溯写入器：把 ACP 报文包装成统一事件，按行追加到 events.jsonl。
// 相对原设计文档补上三项它完全没写的东西：单调 seq（可定位、可续传）、
// parent_seq（血缘链路，替代"看不出来谁触发了谁"）、direction（区分四个方向）。
// 另外每条入站报文都要过方法清单校验：方法未登记或方向不符，一律留痕 + 回错误码，绝不静默挂起。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function newSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `s_${stamp}_${crypto.randomUUID().slice(0, 6)}`;
}

export class TraceWriter {
  /**
   * @param {{dir:string, sessionId:string, projectPath:string, methodTable:object}} opts
   */
  constructor({ dir, sessionId, projectPath, methodTable }) {
    this.dir = dir;
    this.sessionId = sessionId;
    this.projectPath = projectPath;
    this.methods = methodTable.methods ?? {};
    this.rejectedNames = methodTable.rejected ?? {};
    this.seq = 0;
    this.events = [];
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(this.file, '');
    this.broadcast = () => {};
  }

  attachBroadcast(fn) {
    this.broadcast = typeof fn === 'function' ? fn : () => {};
    return this;
  }

  append(ev) {
    const rec = {
      seq: ++this.seq,
      ts: Date.now(),
      session_id: this.sessionId,
      project_path: this.projectPath,
      ...ev,
    };
    this.events.push(rec);
    fs.appendFileSync(this.file, `${JSON.stringify(rec)}\n`);
    try {
      this.broadcast(rec);
    } catch {
      /* 广播失败不影响落盘 */
    }
    return rec;
  }

  /** 用方法清单校验方向与必需参数 */
  validate({ dir, method, message }) {
    const badName = this.rejectedNames[method] ?? null;
    const spec = this.methods[method];

    if (!spec) {
      return {
        status: 'ERROR',
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
          hint: badName ?? 'ACP 未登记此方法名；自定义扩展请用 _ 前缀',
        },
        known_bad_name: badName,
      };
    }
    if (spec.dir !== dir) {
      return {
        status: 'ERROR',
        error: { code: -32600, message: `Invalid direction: ${method} 按协议应为 ${spec.dir}，实际来自 ${dir}` },
        declared_direction: spec.dir,
        actual_direction: dir,
      };
    }
    const params = message.params ?? {};
    const missing = (spec.required ?? []).filter((k) => params[k] === undefined);
    if (missing.length) {
      return {
        status: 'ERROR',
        error: { code: -32602, message: `Missing required params for ${method}`, data: { missing } },
        missing_params: missing,
        declared_direction: spec.dir,
      };
    }
    return { status: 'OK', declared_direction: spec.dir, stability: spec.stability ?? 'stable', known_bad_name: badName };
  }

  /**
   * 登记一条 ACP 报文
   * @param {{dir:string, message:object, parentSeq?:number|null, turnSeq?:number|null, extra?:object}} args
   */
  acp({ dir, message, parentSeq = null, turnSeq = null, extra = {} }) {
    const isResponse = message.id !== undefined && (message.result !== undefined || message.error !== undefined);
    const kind = isResponse ? 'response' : message.id !== undefined ? 'request' : 'notification';
    const method = message.method ?? '(response)';
    const validation = isResponse ? null : this.validate({ dir, method, message });

    return this.append({
      dir,
      kind,
      method,
      rpc_id: message.id ?? null,
      parent_seq: parentSeq,
      turn_seq: turnSeq,
      protocol: validation,
      acp_message: message,
      ...extra,
    });
  }

  /**
   * 宿主内部事件（进程生命周期、策略判定、落盘、协议拦截等）。
   *
   * **回合内产生的 mark 必须传 turnSeq**：`approval/request`、`approval/decision`、`fs/write_applied`、
   * `terminal/created`、`protocol/rejected_unknown_method` 都属于某一轮 session/prompt。
   * 漏了会有两个后果：① 看板把它们丢进"会话级"分组，时间线上看不到它们夹在回合中间；
   * ② 没法按「同回合 + 同方法」归组，被否决清单会为同一件事显示两行。
   * 只有真正不属于任何回合的（host/spawn、rules/loaded、ws/*、index/rebuilt）才允许为空。
   *
   * @see [SPEC §5.2 kind 与 dir 的取值表](SPEC.md#52-kind-与-dir-的取值表)
   * @trace s_20260915-181441_442875#25 实测：补上 turn_seq 后，这条 fs/write_applied 才落进回合 #9
   */
  mark({ name, payload = null, parentSeq = null, turnSeq = null, extra = {} }) {
    return this.append({
      dir: 'internal',
      kind: 'mark',
      method: name,
      rpc_id: null,
      parent_seq: parentSeq,
      turn_seq: turnSeq,
      payload,
      ...extra,
    });
  }

  /** 合规检查结果（可以多条挂在同一个写盘事件下） */
  compliance({ parentSeq, turnSeq = null, record }) {
    return this.append({
      dir: 'internal',
      kind: 'compliance',
      method: 'compliance/check',
      rpc_id: null,
      parent_seq: parentSeq,
      turn_seq: turnSeq,
      payload: { rule_id: record.rule_id, status: record.status, message: record.message },
      compliance_check: record,
    });
  }

  writeSummary(extra = {}) {
    const failed = this.events.filter((e) => e.compliance_check?.status === 'FAILED');
    const protocolErrors = this.events.filter((e) => e.protocol?.status === 'ERROR');
    const summary = {
      session_id: this.sessionId,
      project_path: this.projectPath,
      started_at: this.events[0]?.ts ?? null,
      ended_at: Date.now(),
      total_events: this.events.length,
      errors: {
        protocol: protocolErrors.length,
        compliance_failed: failed.length,
      },
      counts: {
        acp_request: this.events.filter((e) => e.kind === 'request').length,
        acp_notification: this.events.filter((e) => e.kind === 'notification').length,
        permission_requests: this.events.filter((e) => e.method === 'session/request_permission' && e.dir === 'agent->client').length,
        write_attempts: this.events.filter((e) => e.method === 'fs/write_text_file').length,
        write_applied: this.events.filter((e) => e.method === 'fs/write_applied').length,
        terminal_attempts: this.events.filter((e) => e.method === 'terminal/create').length,
        terminal_executed: this.events.filter((e) => e.method === 'terminal/created').length,
      },
      failed_rules: [...new Set(failed.map((e) => e.compliance_check.rule_id))],
      protocol_error_methods: [...new Set(protocolErrors.map((e) => e.method))],
      ...extra,
    };
    fs.writeFileSync(path.join(this.dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }
}
