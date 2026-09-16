# .agents/runner — ACP 宿主最小闭环

这不是插件，是给「Agent 执行器 + 追溯看板」那套设计做的一个**可跑的验证场**。
目的只有一个：把原设计文档里靠描述撑着的东西换成**可执行的证据**。

> **设计规范在 [`SPEC.md`](./SPEC.md)**（v2）。它修正了原文档 18 处问题——方法名 6 个、
> 缺失的 session 层、capability 闸门、注入位置、事件 schema、安全默认值等，并逐条锚到
> 本仓库 `AGENTS.md` 的真实小节。要照着写代码就看 SPEC.md；要跑起来看这个 README。

零依赖（只用 Node 内置模块），不碰仓库里任何已有插件，运行产物全部落在被 gitignore 的 `.agents/trace/`。

## 三个通道，是这套东西的全部

```
                  ┌─────────────────────────────┐
   Agent CLI ──stdio JSON-RPC──▶  宿主 host.mjs  │
  （ACP agent）                  └───────┬───────┘
                              ┌──────────┴───────────┐
                     实时通道 │                      │ 归档通道
                  WebSocket + token               写 .agents/trace/<会话>/
                   （审批、流式）                  （events.jsonl、快照、diff）
                     必须有进程                    纯读盘，零后端可离线
```

- **实时通道**负责拦：`session/request_permission` 是**在途**的一次反向 RPC，
  谁点「批准」必须是一个正在跑的进程在等。端口绑定 `127.0.0.1` 且强制 token——
  不带 token 的升级请求直接 401。原设计文档把端口写死在 9001 且没有鉴权，那等于让本机任何进程替你点批准。
- **归档通道**负责看：每条事件按行追加，`seq` 单调递增、`parent_seq` 串出血缘。
  这一层就是那个「单文件 HTML 看板」将来要读的东西——纯读盘、可离线、可回放，不需要任何服务。

## 快速开始

```bash
# 1) 全放行跑一轮（离线，用内置 mock agent）
node .agents/runner/host.mjs --mock --policy allow --ws-port -1

# 2) 看这一轮的追溯报告（合规有未通过会返回非零码，可当 CI 闸门）
node .agents/runner/trace-report.mjs

# 3) 真实审批：宿主等看板连上，看板侧逐个批复
node .agents/runner/host.mjs --mock --policy ask --ws-port 9101 --token demo --wait-dashboard-ms 9000 &
node .agents/runner/approver.mjs "ws://127.0.0.1:9101/?token=demo" alternate

# 4) 发布物完整性 N-1 核对（跑真实插件目录）
node .agents/runner/host.mjs --mock --policy allow --ws-port -1 --preflight hosts-switcher/0.1.0

# 5) 接真实 agent（任选其一）
node .agents/runner/host.mjs --agent "claude-code-acp" --cwd . --prompt "按 AGENTS.md 检查插件页面"

# 6) 代理模式：直开的客户端会话也留痕（把客户端的 agent 启动命令配成这一条）
node .agents/runner/host.mjs --proxy --agent "<真 agent CLI>" --cwd <项目根>
```

`--policy` 三档：`allow` 全放行 / `deny` 全拒绝（用来验证「拒绝之后磁盘上确实什么都没发生」）/
`ask` 交给看板，**无看板连接或超时一律按拒绝处理**（安全默认，不是放行）。
代理模式默认 `allow`（纯记录）——外层 client 的 stdin 是协议管道没有 TTY，`ask` 在无看板时会全拒；
代理契约测试：`node .agents/runner/tests/proxy-test.mjs`。

## 方法清单是唯一依据

`acp-methods.json` 登记了方法的**方向 + kind + 必需参数**，并且把原设计文档里用错的名字
逐条记在 `rejected` 段。宿主对每条入站报文先查这张表：

- 方法未登记 / 方向不对 / 缺必需参数 → 立刻回 `-32601` / `-32600` / `-32602`，**绝不静默挂起**；
- 命中的错名字（`tools/call`、`fs_patch`）会在追溯报告里带上「原文档里的名字」提示。

真实名字对照：`fs/write` → `fs/write_text_file`；`terminal/exec` → `terminal/create` + `terminal/wait_for_exit` + `terminal/output`；
`permission/request` → `session/request_permission`（**方向是 agent→client**）；`tools/call` 是 MCP 的命名；`fs_patch` 不存在。

## 规则怎么进去

`initialize` 的 params 只有 `protocolVersion` / `clientCapabilities` / `clientInfo`，**塞不进 System Prompt**。
本宿主的做法是两条协议允许的路：

1. `session/new` 的 `_meta.sparkTrace` 里带 `sandbox`、`trace_dir`、`rules_source` 与规则文件的 sha256 前 16 位；
2. `session/prompt` 的 `content` 里放一个 `resource` 块（`file:///.../AGENTS.md`）+ 一个 `text` 块。

同时会检查 agent 是否声明了 `embeddedContext`；没声明就只是把规则拼进文本块。

## 合规检查器（挂在写盘之后）

| rule_id | 依据 | 触发 |
|---|---|---|
| `AGENTS_MD_SEC_2_EXTRACTION` | `AGENTS.md §2 触发阈值` | 内联 `<style>`/`<script>` 超 100 行，或 HTML 超 300 行 |
| `AGENTS_MD_SEC_2_SYNTAX` | `AGENTS.md §2 提取做法第 4 条` | 写 `.js/.mjs` 后跑 `node --check` |
| `AGENTS_MD_SEC_3_HARDENING` | `AGENTS.md §3 其它硬性约束第 1 条` | 插件页面（`<版本>/index.html` / `page.*`）缺右键菜单 + F12/F5/Ctrl+P 拦截 |
| `SPARK_RELEASE_INTEGRITY` | `AGENTS.md §3 发布物完整性` | `--preflight`：`git ls-files` 条数 − 1 = `signature.json` 的 `files` 条数 |

状态有四种：`PASSED` / `FAILED` / `SKIPPED`（规则不适用）/ `ERROR`。原文档只给了 `PASSED` 一种。

## 事件 schema

```jsonc
{
  "seq": 19,                    // 单调递增，可定位、可续传（原文档没有）
  "ts": 1789459485246,
  "dir": "agent->client",       // client->agent | agent->client | internal
  "kind": "request",            // request | response | notification | mark | compliance
  "method": "fs/write_text_file",
  "rpc_id": 4,                  // JSON-RPC id，用于把审批与配对调用连起来（原文档没有）
  "parent_seq": 7,              // 血缘：谁触发了它
  "turn_seq": 7,                // 属于哪一轮 session/prompt
  "protocol": { "status": "OK", "declared_direction": "agent->client", "stability": "stable" },
  "acp_message": { "jsonrpc": "2.0", "id": 4, "method": "...", "params": { } },
  "compliance_check": { "rule_id": "...", "rule_source": "...", "status": "FAILED", "message": "...", "details": { } }
}
```

配套产物：`snapshots/`（写盘前后各一份）、`diffs/`（**宿主自己算的** unified diff，
因为 ACP 没有 patch 方法）、`summary.json`。

## 实测结论（都在本机跑过）

| 场景 | 结果 |
|---|---|
| `--policy allow` 全流程 | 98 事件 / 21 条合规检查（通过 5 · 未通过 4 · 跳过 12）/ 7 次写盘 · 1 条命令 |
| 原文档里的错方法名 | `tools/call`、`fs_patch` 均被回 `-32601` 并在报告里标注来源 |
| 三条硬阈值 | 319 行 HTML → 超 300 红；131 行内联 `<style>` → 超 100 红；`broken.js` → `node --check` 红 |
| 页面加固 | 带加固段的 `page.js` 绿，缺加固段的红（含缺失标记清单） |
| WS 看板交替批复 | 8 次批复（4 放行 / 4 拒绝）：放行的落盘并跑合规，**被拒的磁盘上确实没有文件** |
| `--policy deny` | 7 次写盘尝试全部被拒，沙箱落盘文件数 = 0 |
| `--preflight hosts-switcher/0.1.0` | ✓ 清单 8 条 = git 追踪 9 − 1 |
| `--proxy` + 假 client（proxy-test 17 项） | 双向转发零污染（stdout 全 JSON）、反向请求就地拦截、`_meta.sparkTrace` 注入生效、断开后 summary/index 落盘 |

## 已知的接缝与没做的事（别当成已完成）

- **审批没有配对语义**。ACP 的 `session/request_permission` 和随后的 `terminal/create` 之间
  没有明确的关联字段，所以本宿主会对同一件事问两次（先问「能不能执行」，再拦「执行」本身）。
  真实系统要么按启发式配对，要么在协议层补 `_meta` 关联——这是个需要设计的缺口，不是 bug。
- **`--agent` 的 shell 传参简化**：用 `shell: true` 拉字符串命令，没做 argv 解析与版本探测。
- 未实现 `session/cancel` 的主动取消（agent 侧可以发，宿主只记录）、`session/load`/`resume`/`list`、`elicitation/create`。
- 写盘只做整文件替换（协议本身如此），没做按行 patch。
- 路径白名单只到「必须在工作区内、不许碰 `.git/` 和本目录自身」这一层，没做细粒度规则。
- **看板 UI 还没有**。按你给的参考（`write-notes-like-deepseek` 的 `board.html`）那套做的话，
  它只需要读 `events.jsonl` + `diffs/` —— 纯前端单文件就够，不需要连这个 WebSocket。

## 文件

| 文件 | 作用 |
|---|---|
| `host.mjs` | 宿主：拉进程、走生命周期、拦副作用、落盘、广播 |
| `acp-methods.json` | 方法清单与错名对照（宿主的校验依据） |
| `trace.mjs` | 追溯写入器（seq / parent_seq / 协议校验 / 汇总） |
| `compliance.mjs` | 合规评估器 + 风险判定 + 发布物完整性核对 |
| `diff.mjs` | 自算 unified diff（LCS） |
| `ws.mjs` | 零依赖 WebSocket 服务端（127.0.0.1 + token） |
| `mock-agent.mjs` | 测试替身：离线可测的 ACP agent，故意发出该被拦的内容 |
| `approver.mjs` | 看板侧审批客户端（测试替身，用 Node 22 内置 WebSocket） |
| `trace-report.mjs` | 归档读取端：人读时间线 + 血缘树，合规未通过则非零退出 |
