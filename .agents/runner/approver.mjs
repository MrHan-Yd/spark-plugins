#!/usr/bin/env node
// 看板侧的审批客户端（测试替身）。
// 它证明的是「实时通道真的能拦住一次在途操作」—— 这是纯前端单文件看板做不到的那部分。
// Node 22 自带全局 WebSocket，所以零依赖。
//
// 用法：node approver.mjs "ws://127.0.0.1:9001/?token=xxx" [allow|deny|alternate]
const url = process.argv[2];
const mode = process.argv[3] ?? 'allow';
if (!url) {
  process.stderr.write('用法: node approver.mjs <ws url> [allow|deny|alternate]\n');
  process.exit(2);
}

const ws = new WebSocket(url);
let seen = 0;
let decided = 0;

ws.addEventListener('open', () => process.stderr.write('[approver] 已连上实时通道\n'));
ws.addEventListener('close', () => {
  process.stderr.write(`[approver] 通道关闭，共收到 ${seen} 个事件、批复 ${decided} 次\n`);
  process.exit(0);
});
ws.addEventListener('error', (e) => {
  process.stderr.write(`[approver] 连接错误：${e?.message ?? e?.type ?? 'unknown'}\n`);
  process.exit(1);
});

ws.addEventListener('message', (ev) => {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (msg.type !== 'PERMISSION_REQUEST') {
    seen++;
    return;
  }
  decided++;
  const options = Array.isArray(msg.options) ? msg.options : [];
  const allow = options.find((o) => String(o.kind ?? o.optionId ?? '').startsWith('allow'))?.optionId ?? 'allow';
  const reject = options.find((o) => String(o.kind ?? o.optionId ?? '').startsWith('reject'))?.optionId ?? null;

  let pick;
  if (mode === 'deny') pick = reject;
  else if (mode === 'alternate') pick = decided % 2 === 1 ? allow : reject;
  else pick = allow;

  process.stderr.write(
    `[approver] #${decided} ${msg.risk_level} ${msg.reason} -> ${pick ?? '拒绝（cancelled）'}\n`,
  );
  ws.send(JSON.stringify({ type: 'permission_decision', rpc_id: msg.rpc_id, optionId: pick }));
});
