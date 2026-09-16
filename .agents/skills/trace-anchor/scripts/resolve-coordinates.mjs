#!/usr/bin/env node
// 解析当前会话的 @trace 锚点坐标：会话 id + events.jsonl 里已存在的事件序号。
// 锚点只能指向「写锚点那一刻已落盘」的事件（正在写的文件引用不了自己这次写盘的 seq），
// 所以流程是：先跑命令/读文件拿证据，再跑本脚本挑坐标，下次写盘时把锚挂上去。
// @see [SPEC §5.6 反向锚点](../../../runner/SPEC.md#56-反向锚点代码--追溯记录)
// @see [条件式反向锚点](../../../notes/implemented/process/2026-09-16-条件式反向锚点.md)
//
// 用法：
//   node resolve-coordinates.mjs               # 读环境变量 SPARK_TRACE_SESSION / SPARK_TRACE_DIR
//   node resolve-coordinates.mjs <trace目录>    # 显式指定会话目录（覆盖环境变量推导）
// 退出码：0 正常；2 无宿主链路或 trace 产物缺失——两种失败必须可区分（无宿主要走降级路径，不是报错）。
import fs from 'node:fs';
import path from 'node:path';

const explicitDir = process.argv[2];
if (!explicitDir && !process.env.SPARK_TRACE_SESSION) {
  process.stdout.write('无宿主链路：SPARK_TRACE_SESSION 未设置。\n按 trace-anchor 技能的无宿主路径走：决策笔记 + @see，禁止 @trace。\n');
  process.exit(2);
}

const dir = path.resolve(explicitDir ?? process.env.SPARK_TRACE_DIR ?? '');
const session = process.env.SPARK_TRACE_SESSION ?? path.basename(dir);
const file = path.join(dir, 'events.jsonl');

if (!fs.existsSync(file)) {
  process.stdout.write(`trace 产物不存在（没有 events.jsonl）：${dir}\n`);
  process.exit(2);
}

const recent = [];
let lastSeq = null;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line) continue;
  let e;
  try { e = JSON.parse(line); } catch { continue; } // 坏行忽略，与校验器同策略
  if (typeof e.seq !== 'number') continue;
  lastSeq = e.seq;
  const what = e.acp_message
    ? `${e.dir ?? '?'} ${e.acp_message.method ?? ''}`.trim()
    : e.kind === 'compliance'
      ? `${e.compliance_check?.rule_id ?? 'compliance'} ${e.compliance_check?.status ?? ''}`.trim()
      : e.method ?? e.kind ?? '?';
  recent.push({ seq: e.seq, what });
}

process.stdout.write(`session : ${session}\n`);
process.stdout.write(`last_seq: ${lastSeq ?? 0}\n`);
process.stdout.write('最近事件（事件序号从这里挑，只挑能证明结论的那条）：\n');
for (const r of recent.slice(-8)) process.stdout.write(`  #${r.seq}  ${r.what}\n`);