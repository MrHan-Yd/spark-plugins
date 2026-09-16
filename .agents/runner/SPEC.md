# Agent 执行器与可视化追溯看板 · 系统设计与实现规范 v3

> **v1 的问题**：v1 自称 "ACP Compatible"，但方法名有 6 个在协议里不存在、生命周期漏了整整一层、
> 且核心卖点（拦截 / 合规自检）依赖一个它全篇没提的开关。按 v1 直接编码会得到一个跑不起来、
> 或者跑起来但**永远收不到任何事件**的系统。
>
> **v2/v3 的正确性来源**：
> 1. 协议（方法名、方向、必需参数、扩展约定）以 <https://agentclientprotocol.com/protocol> 为准；
> 2. 合规规则逐条锚定本仓库 `AGENTS.md` 的真实小节，不发明编号；
> 3. 下文所有"实测"结论，都在 `.agents/runner/` 上真跑过（命令与期望输出见附录 C）。
>
> 参考实现：`.agents/runner/`（Node 零依赖，10 个 .mjs 共 2714 行 + `acp-methods.json`，含 mock agent、审批客户端与锚点校验器）
> 与 `trace-board/0.1.0/`（看板三件套 + 数据层五模块）。

---

## 0. 变更清单

### 0.1 v1 → v2

| # | v1 的写法 | 事实 | v2 的处理 |
|---|---|---|---|
| 1 | 生命周期只有 3 个 Phase | 缺 `session/new` 与 `session/prompt`，流程断在握手后 | 扩成 6 个阶段（§3） |
| 2 | `tools/call` | 不存在。ACP 的工具调用是 `session/update` 通知（`update.kind = tool_call`）；`tools/call` 是 MCP 的命名 | 删除，改用通知（§2.3） |
| 3 | `context/update` | 不存在。没有这个"上下文同步"方法 | 规则改走 `session/new` 的 `_meta` + `session/prompt` 的 `resource` 块（§3.3） |
| 4 | `fs/write` | 真名 `fs/write_text_file` | 改名（§2.2） |
| 5 | `terminal/exec` | 真名是 `terminal/create` + `terminal/wait_for_exit` + `terminal/output` | 改名并补执行语义（§2.2） |
| 6 | `permission/request` | 真名 `session/request_permission`，且**方向是 agent → client 的反向 RPC**，不是宿主主动推给看板 | 改名 + 明确方向（§2.2、§4） |
| 7 | `fs_patch` | 不存在。ACP 只给整文件写，没有 patch 方法 | 删除；Diff 由宿主自己算（§5.4） |
| 8 | 「AGENTS.md 注入 initialize 的 System Prompt」 | `initialize` 的 params 只有 `protocolVersion` / `clientCapabilities` / `clientInfo`，塞不进去 | 改走协议允许的两条路（§3.3） |
| 9 | 「非侵入式宿主」作为卖点 | 与"能拦截副作用"互斥：不声明能力就收不到事件 | 改成"双通道 + 能力声明闸门"，并把取舍写明（§1.2） |
| 10 | 事件里没有序号、没有关联、没有方向 | 断连即丢、无法定位、血缘不可见 | 补 `seq` / `parent_seq` / `dir` / `rpc_id`（§5） |
| 11 | 审批 payload 只有 `timeout_ms`，没说超时怎么办 | 未定义即隐患 | **超时与无人值守一律按拒绝**（§4.3） |
| 12 | 端口写死 9001、无鉴权 | 本机任何进程都能替你点"批准" | 绑 127.0.0.1 + 强制 token，默认随机端口（§4.2） |
| 13 | `compliance_check.status` 只有 `PASSED` | 无法表达"不适用"和"检查器自己崩了" | 五种状态：`PASSED`/`FAILED`/`WARN`/`SKIPPED`/`ERROR`（§6.2） |
| 14 | `rule_id: AGENTS_MD_SEC_3` 指向不明 | §3 第一条恰好是页面加固，但三件套阈值在 §2，v1 没给它 id | 每条规则显式标注 `rule_source`（§6.1） |
| 15 | 「比对二进制文件数量」 | 实际比的是"追踪文件总数 − 1"，不是二进制数 | 改成 N−1 的准确定义（§6.5） |
| 16 | 「Vue 3 / React」 | 不是决定 | 定死为单文件 HTML + 原生 JS（§7.1） |
| 17 | 「Rust 或 Node.js」 | 不是决定 | 定死为 Node.js ≥ 20（§7.1） |
| 18 | §5 编号出现两个「2.」，§6 是「3. / 2.」倒序 | 编号错位会被 AI 当成真实顺序 | 全部重排（§7） |
| 19 | 代码里没有"当初为什么这么写"的回链 | 文件改名、产物清理后链路静默断掉；没有锚点则回链覆盖率直接归零 | 增补 §5.6 反向锚点（`@see`/`@trace`）+ `check-trace-anchors.mjs` 机械校验（验收 #14/#15） |
| 20 | 锚点只校验"已有不腐烂"，管不住覆盖率 | 新决策可以完全不挂锚，事后补要翻整个 trace 库 | `AGENTS.md §1` 写码即留痕条款 + `TRACE_WHY_ANCHORED` WARN 级规则（§5.6/§6.1，2026-09-16） |

### 0.2 v2 → v3（决策笔记与看板重制，2026-09-16）

| # | v2 的状态 | 事实 / 动机 | v3 的处理 |
|---|---|---|---|
| 1 | 决策只存在于代码注释与 trace 事件里 | 跨会话检索不到「当初为什么这么选」；看板只能回放运行事实，没有沉淀层 | 新增 **AGENTS.md §4 决策笔记**（提示词条款：何时写/路径即状态即分类/四节骨架）；宿主解析 `.agents/notes/` 进索引（§5.8）；合规新增 `AGENT_NOTE_FORMAT`（§6.1）。谱系：write-notes-like-deepseek（DeepSeek Harness 的 Agent Notes 实践） |
| 2 | 看板四个模块是纯 trace 数据看板 | 决策密度取决于 trace 的偶然性；参考站已证明「决策知识库」形态更值钱 | 四模块升级为**决策笔记驱动**：KPI 四卡、承重墙笔记卡（被引用 ×N）、分类面板、轨道点时间线、避坑三块卡、六列总表；无笔记自动回落 trace 视图（§7.3） |
| 3 | `index.json` / digest 的 schema 只活在代码注释里 | 它是字段最密集、演进最频繁的契约，却没有权威定义 | 成文 **§5.8**（schema bump 纪律、原子写、diffs_inline 封顶） |
| 4 | 合规状态枚举扩张要手工同步看板三处 | WARN 那次是靠人肉同步的，没有机制兜底 | 看板 `COMPLIANCE_STATUS` 唯一权威单表（label/cls/rank 一表派生）+ `contract-test.mjs` 三方机械核对（SPEC §6.2 ↔ 看板表 ↔ runner 产出字面量）（§5.8） |
| 5 | mock agent 只写沙箱坏文件 | 决策笔记链路（审批 → 格式校验 → 索引 → 看板）没有离线样本 | mock 写入 implemented / rejected 样例笔记各一篇（互链），附录 C 数字随之更新 |
| 6 | 看板测试基线 53 → 74 项 | 信息架构重制后断言面变了 | **83 项**（KPI / note-card / chamber / 笔记详情抽屉 / 全局搜索）+ 枚举契约测试 13 项（§8、附录 A2） |

---

## 1. 系统总体架构

### 1.1 双通道结构

v1 把"实时展示"和"能拦住"当成一件事，所以只能提出"WebSocket 单通道"。
实际这是**两个问题**，通道也不同：

```
                        ┌──────────────────────────────┐
   Agent CLI  ──stdio──▶│   宿主 Host（唯一能看到 stdio）│
 （ACP agent）JSON-RPC  └───────┬──────────────┬───────┘
                        ┌──────┴──────┐  ┌────┴──────────────┐
                        │  实时通道    │  │  归档通道          │
                        │ WS + token  │  │ .agents/trace/... │
                        │ 审批 · 流式  │  │ 事件流·快照·diff   │
                        │ 必须有进程   │  │ 纯读盘·零后端·可离线│
                        └──────┬──────┘  └────┬──────────────┘
                               ▼              ▼
                        ┌──────────────────────────────────┐
                        │  看板 Dashboard（同一套 UI 两模式）│
                        └──────────────────────────────────┘
```

| 通道 | 承载 | 为什么必须这样 |
|---|---|---|
| **实时通道** | 审批（Approve/Reject）、流式思考轨迹 | `session/request_permission` 是**在途的**一次反向 RPC，必须有一个正在运行的进程在等回答。单文件 HTML 做不到。 |
| **归档通道** | 事件流、写前/写后快照、Diff、合规结果 | 落盘后就是普通文件。纯前端可读、可离线、可回放、可进版本库审查。 |

**验收要求**：实时通道断开时，归档通道必须仍然完整可用（落盘不依赖广播成功）。

### 1.2 capability 闸门（v1 缺失的关键设计）

ACP 里的文件与终端方法是**客户端能力**：只有当宿主在 `initialize` 里声明了对应 capability，
agent 才会把这些操作**反向路由**给宿主。不声明，agent 自己落盘，宿主一无所知。

```
宿主在 initialize 声明 clientCapabilities
├── 声明了 fs.writeTextFile + terminal
│   → agent 反向调用 fs/write_text_file / terminal/create
│   → 宿主可拦截 · 可审批 · 可自算 Diff · 可跑合规检查
└── 没声明
    → agent 自行写盘，协议里不留任何记录
    → 看板零事件，全部合规检查器永不触发
```

**结论（必须写进设计，不许含糊）**：「完全非侵入式」与「能拦截副作用」互斥。
本系统选择**声明能力**，并把代价讲清楚：宿主会出现在关键路径上，且宿主崩溃会阻断 agent 的写入。
**降级路径**：若声明能力不可接受，则看板必须显式降级为"仅有对话流，不提供任何合规保证"，
并在 UI 顶部常驻提示——不允许静默地伪装成有拦截。

### 1.3 组件职责

- **宿主 Host**：拉起 agent 子进程；跑生命周期；校验入站报文；执行审批闸门；落盘；广播。
  唯一被允许接触 stdio 与文件系统的组件。
- **看板 Dashboard**：只消费结构化数据。**不直接操作文件系统**（归档模式下只读用户显式授权的目录）。
- **目标项目**：零依赖。除 `.agents/trace/`（运行产物，建议 gitignore）外不留下任何东西。

---

## 2. 协议基线

### 2.1 必须显式协商版本

`initialize` 必须携带 `protocolVersion`，并把 agent 返回的版本记入 trace。
已知漂移：**v1 的 `session/load` 在 v2 被 `session/list` + `session/resume` + `session/close` 取代**。
不锁版本就会踩这个。

### 2.2 方法清单（唯一依据）

宿主与看板都必须以这份清单校验报文。**下表即权威**，代码里应落成一份机器可读的表（参考
`.agents/runner/acp-methods.json`），而不是散落在 if-else 里。

**Client（宿主）→ Agent**

| 方法 | 类型 | 必需参数 | 说明 |
|---|---|---|---|
| `initialize` | request | `protocolVersion` | 另带 `clientCapabilities` / `clientInfo`。**无 systemPrompt 字段** |
| `authenticate` | request | `methodId` | 仅当 `initialize` 返回的 `authMethods` 非空时调用 |
| `session/new` | request | `cwd`, `mcpServers` | 返回 `sessionId`。缺这步后续无从下手 |
| `session/prompt` | request | `sessionId`, `content[]` | 返回带 `stopReason` |
| `session/cancel` | notification | `sessionId` | 无响应。拦截系统的必备件 |
| `session/list` / `session/resume` / `session/close` | request | — | v2 新增 |
| `session/set_mode` / `session/set_model` | request | — | 可选 |

**Agent → Client（反向 RPC，宿主实现）**

| 方法 | 类型 | 必需参数 | 宿主要做的事 |
|---|---|---|---|
| `session/request_permission` | request | `sessionId`, `toolCall`, `options[]` | 转给看板，按用户选择回 `{outcome:{outcome:'selected',optionId}}` 或 `{outcome:{outcome:'cancelled'}}` |
| `fs/read_text_file` | request | `sessionId`, `path` | 可选 `line` / `limit`；返回 `{content}` |
| `fs/write_text_file` | request | `sessionId`, `path`, `content` | **整文件写**。过闸门 → 存快照 → 计算 Diff → 跑合规 |
| `terminal/create` | request | `sessionId`, `command` | 返回 `{terminalId}` |
| `terminal/output` | request | `sessionId`, `terminalId` | 返回 `{output, truncated, exitStatus?}` |
| `terminal/wait_for_exit` | request | `sessionId`, `terminalId` | 返回 `{exitCode, signal}` |
| `terminal/kill` / `terminal/release` | request | `sessionId`, `terminalId` | — |

**Agent → Client（通知）**

| 方法 | 必需参数 | 说明 |
|---|---|---|
| `session/update` | `sessionId`, `update` | **"思考轨迹"的唯一来源**。`update.kind` 取值含 `agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk` / `tool_call` / `tool_call_update` / `plan` 等 |

**兼容性注意**：`terminal/create` 的 `command` 在官方 schema 里是 argv 数组；部分实现拆成
`command` + `args`。**宿主两者都要兼容**，并把归一化后的 argv 数组写进 trace。

### 2.3 v1 错名勘误表（写进代码，用于给报错加提示）

| v1 写的 | 实况 |
|---|---|
| `tools/call` | MCP 的命名。ACP 的工具调用以 `session/update`（`kind = tool_call`）下发 |
| `context/update` | 不存在 |
| `fs/write` | 真名 `fs/write_text_file` |
| `terminal/exec` | 真名 `terminal/create` + `terminal/wait_for_exit` + `terminal/output` |
| `permission/request` | 真名 `session/request_permission`，方向是 agent → client |
| `fs_patch` | 不存在。写盘只有整文件 |

宿主遇到这些名字必须**立刻回 `-32601` 并附提示**，不得静默挂起（v1 的 §1 自己就要求"禁止静默挂起"）。

### 2.4 报文约定

- 传输：stdio，换行分隔的 JSON-RPC 2.0，**同一连接双向**。
- **所有 `path` 必须是绝对路径**。v1 示例里的 `local-search/0.1.0/page.js` 违反此约定。
- 行号 **1-based**。
- ACP 定义的属性名用 `camelCase`；判别式字段的字符串值用 `snake_case`。
- 扩展：用 `_meta` 字段，或把方法名以 `_` 开头。**不发明顶层字段**。
- 错误：标准 JSON-RPC 错误码。

---

## 3. 生命周期（取代 v1 的三个 Phase）

### Phase 0 · 准备

宿主解析参数、建会话目录、加载方法清单、启动实时通道。此时**尚无任何 ACP 报文**。

### Phase 1 · `initialize` 握手与能力协商

```jsonc
// 宿主 → agent
{ "jsonrpc":"2.0", "id":1, "method":"initialize", "params":{
  "protocolVersion": 1,
  "clientCapabilities": {
    "fs": { "readTextFile": true, "writeTextFile": true },      // ← 闸门在这里
    "terminal": { "create": true, "output": true, "waitForExit": true, "kill": true, "release": true }
  },
  "clientInfo": { "name": "spark acp host", "version": "0.1.0" }
}}
```

- 记录 agent 返回的 `agentCapabilities`，作为看板"授权能力清单"的数据源。
- **必须检查 `promptCapabilities.embeddedContext`**：为真才能用 `resource` 内容块注入规则；
  为假则只能退化为把规则拼进 `text` 块，并记一条降级事件。
- 若 `agentCapabilities` 里没有 `fs` / `terminal` 相关能力，说明**该 agent 不会走宿主写盘**，
  必须立刻在看板提示"合规检查不会生效"。这是 v1 最致命的盲点，不许再默默略过。

### Phase 2 · `session/new` 建立会话 + 同步规则

```jsonc
{ "jsonrpc":"2.0", "id":2, "method":"session/new", "params":{
  "cwd": "/abs/path/to/project",
  "mcpServers": [],
  "_meta": { "sparkTrace": {
    "sandbox": "/abs/.../.agents/trace/<会话>/sandbox",
    "trace_dir": "/abs/.../.agents/trace/<会话>",
    "rules_source": "AGENTS.md",
    "rules_sha256_16": "633ab2c0edc95732"
  }}
}}
```

- `cwd` 决定工作根，也是路径白名单的边界。
- 规则**不注入 initialize**，而是走 `_meta` 携带来源与指纹（指纹用于事后核对"当时生效的是哪一版规则"）。
- v1 提到的 Git Workspace 状态（`git status`）由宿主自己采集后随规则一并交付，**不要假装有 `context/update` 方法**。

### Phase 3 · `session/prompt` 下发指令

```jsonc
{ "jsonrpc":"2.0", "id":3, "method":"session/prompt", "params":{
  "sessionId": "s_...",
  "content": [
    { "type":"resource", "resource": { "uri":"file:///abs/path/AGENTS.md",
                                       "mimeType":"text/markdown", "text":"<文件全文>" } },
    { "type":"text", "text":"本轮的用户指令" }
  ]
}}
```

本方法的事件 seq 即本轮（turn）的根，后续所有事件以它为 `turn_seq`。

### Phase 4 · 执行与拦截

- agent 以 `session/update` 通知流式输出思考与工具调用；宿主逐条落盘并按需展示。
- agent 发起反向 RPC 时，宿主**先查清单再处理**：方法未登记 / 方向不对 / 缺必需参数 → 立刻回错误码。
- 有副作用的方法（`fs/write_text_file`、`terminal/create`）**必须先过审批闸门**（§4）。
- 写盘成功后：存写前/写后快照 → 宿主自算 Diff → 跑合规评估器 → 结果一并落盘。

### Phase 5 · 收尾与归档

- 记录 `stopReason`；写 `summary.json`。
- 汇总必须区分**尝试 / 成功 / 被拒**，只数"尝试次数"会把被拒的算成写成功（实测踩过）。
- 关闭 agent 子进程与实时通道；归档目录刷新 mtime（看板据此判断最新会话）。

### Phase 0 · 代理模式（--proxy）：直开会话上链路

常规模式由宿主**拉起** agent、驱动一轮生命周期后退出；直开的客户端会话（ZCode 等直接启动 agent）
不经宿主，协议事件流为零 —— 这是 opt-in 留痕模型的盲区。`--proxy` 补上它：

```
外层 client（ZCode 等）──stdio──▶ 宿主 --proxy ──stdio──▶ 真 agent
                                 （对外伪装 agent，对内仍是 client）
```

- **透明转发**：外层 stdin 的请求/通知逐条转发给 agent 并落盘；agent 的响应与 `session/update`
  通知原样转发回外层。dir 沿用 `client->agent` / `agent->client`（代理透明），看板 schema 零改动。
- **反向请求就地处理**：`session/request_permission`、`fs.*`、`terminal.*` 由宿主自己应答——审批闸门、
  合规评估、快照、Diff 全部生效，**不外泄**给外层 client（外层只看到 `session/update` 流与最终响应）。
  方法未登记仍回 `-32601`，绝不静默挂起。
- **唯一加料点**：转发 `session/new` 时注入 `_meta.sparkTrace`（sandbox / trace_dir / 规则指纹），
  agent 拿到坐标才能挂 `@trace` 锚；trace 里以 `proxy/session_new_mutated` 披露。
- **stdout 纪律**：代理模式下宿主进程的 stdout 是对外协议通道，人话日志一律改走 stderr，
  混入非 JSON 行即协议损坏（契约测试断言外层 stdout 零污染）。
- **默认 `--policy allow`（纯记录）**：外层 stdin 是协议管道没有 TTY，`ask` 在无看板时按安全默认
  全拒、agent 直接废；要人工审批仍可显式 `--policy ask` + 看板连接。
- **生命周期**：一个代理进程 = 一个追溯会话；随外层 client 断开 / agent 退出 / SIGINT 结束，
  走统一收尾（summary + 索引重建），多轮 prompt 是多回合（`turn_seq` 按转发的 `session/prompt` 划分）。

接入方式：把客户端的 agent 启动命令配成
`node <runner>/host.mjs --proxy --agent "<真 agent CLI>" --cwd <项目根>`。
契约测试：`.agents/runner/tests/proxy-test.mjs`（假 client 双向驱动 + 落盘断言，17 项）。

**hook 桥（已落地的补充手段）**：客户端配不了自定义 agent 命令时，用 PreToolUse hook
（`.agents/runner/hook-recorder.mjs`，匹配 Write/Edit/Bash）把工具调用写成
`provenance:'hook'` 的事件进 `.agents/trace/hook_<session>/`，每次追加后重建索引让看板即时可见。
这是**客户端自报**——无审批闸门、无合规链、深度到操作级（工具/文件/命令，内容截断留档
`hook-raw.jsonl`），录制器红线是永远 exit 0、stdout 静默、原始 payload 兜底对账。

---

## 4. 安全边界与人工审批

### 4.1 需要拦截的操作

| 方法 | 风险 | 理由 |
|---|---|---|
| `fs/write_text_file` | HIGH | 写磁盘 |
| `terminal/create` | HIGH（`git commit/push`、`rm`、`cargo`、`npm` 等）；否则 MEDIUM | 起进程 |
| `session/request_permission` | 由 `toolCall.title` / `kind` 判定 | agent 主动申请授权 |
| `fs/read_text_file` | LOW | 只读，不拦 |

风险等级必须由**参数内容**判定，而不是只看方法名。

### 4.2 实时通道鉴权（v1 缺失）

- 绑定 `127.0.0.1`，**禁止 0.0.0.0**。
- 升级请求必须带 token（查询参数或 `x-trace-token` 头），不匹配直接 `401` 并断开。
- 端口默认随机（传 `0` 让内核分配）或可配置；**不硬编码 9001**。
- token 每次会话重新生成并打印给用户；不复用。

### 4.3 审批流程与默认值

```
1. 宿主记录 approval/request 事件（含 rpc_id、风险、理由、policy）
2. 策略 allow → 直接放行；deny → 直接拒绝；
   ask → 广播 PERMISSION_REQUEST 给看板，等待匹配 rpc_id 的决定
3. 超时（默认 60s）/ 无看板连接 / 非交互环境 → 一律按【拒绝】处理
4. 记录 approval/decision 事件（含 option_id、approved、decided_by、latency_ms）
5. 拒绝时向 agent 回错误，明确说明"审批未通过"，不带任何副作用
```

- **Approve/Reject 按钮的取值必须来自 agent 给的 `options`**（`allow_once` / `allow_always` /
  `reject_once` 等），不要自造两个按钮。
- 无 `options` 的方法（`fs.*` / `terminal.*`）由宿主策略决定，回 `{outcome:{outcome:'cancelled'}}` 表示拒绝。

### 4.4 文件系统边界

写盘与执行一律限制在 `cwd` 之内；并额外拒绝：

- 任何 `/.git/` 路径；
- 宿主自身的源码目录；
- 工作区之外的绝对路径（回 `-32001`）。

### 4.5 已知接缝：审批与后续调用没有关联字段 ⚠️

ACP 的 `session/request_permission` 与随后的 `terminal/create` **之间没有关联字段**。
宿主只能：要么对同一件事问两次（先问授权、再拦执行），要么做启发式配对。

**v2 的处理**：必须显式选择一种并写明。

- 方案 A（默认，安全）：两次都拦，看板把同一回合内的相邻请求**归组展示**，减少重复打扰。
- 方案 B（需协议扩展）：agent 在后续调用的 `_meta.sparkTrace.tool_call_id` 里回填
  permission 请求的 `toolCall.id`，宿主据此免二次询问。**这是扩展，不是标准 ACP，需双方实现。**

不许"看起来配对了、实际没配对"。

---

## 5. 数据规范

### 5.1 事件 envelop（权威版本）

```jsonc
{
  "seq": 19,                      // 会话内单调递增整数。排序、定位、断点续传的唯一依据
  "event_id": "s_20260915-160537_411db0#19",   // 展示用，由 session_id#seq 派生
  "ts": 1789459485246,            // epoch ms
  "session_id": "s_20260915-160537_411db0",
  "project_path": "D:\\demo\\test01\\spark-plugins",

  "dir": "agent->client",         // client->agent | agent->client | internal
  "kind": "request",              // request | response | notification | mark | compliance
  "method": "fs/write_text_file",
  "rpc_id": 4,                    // JSON-RPC id；response 用它反查对应 request 的 seq
  "parent_seq": 7,                // 血缘：谁触发了它
  "turn_seq": 7,                  // 属于哪一轮 session/prompt

  "protocol": {                   // 仅入站报文有；校验结果
    "status": "OK",               // OK | ERROR
    "declared_direction": "agent->client",
    "stability": "stable",
    "known_bad_name": null        // 若命中了 v1 错名，填解释
  },

  "acp_message": { "jsonrpc": "2.0", "id": 4, "method": "...", "params": { } },

  "compliance_check": {           // 仅 compliance 类事件有
    "rule_id": "AGENTS_MD_SEC_2_EXTRACTION",
    "rule_source": "AGENTS.md §2 触发阈值",
    "status": "FAILED",
    "message": "[Violation] big-page.html Exceeds 300 lines, extract JS/CSS required.",
    "details": { }
  }
}
```

**为什么必须有 `seq`**：v1 只有 `timestamp` 和字符串 `event_id`。同一毫秒的多条事件无法排序，
断连后无法知道缺了哪几条，也无法做增量续传。

### 5.2 `kind` 与 `dir` 的取值表

| `dir` | `kind` | 含义 |
|---|---|---|
| `client->agent` | `request` / `response` / `notification` | 宿主发出的报文 |
| `agent->client` | `request` / `response` / `notification` | agent 发出的报文 |
| `internal` | `mark` | 宿主内部事实：`host/spawn`、`host/agent_exit`、`approval/request`、`approval/decision`、`fs/write_applied`、`terminal/created`、`ws/dashboard_ready`、`protocol/rejected_unknown_method`、`rules/loaded` |
| `internal` | `compliance` | 一次合规检查结果 |

`mark` 类事件的 `method` 就是 `name`，`payload` 携带结构化细节。看板据此渲染"宿主做了什么"，
而不只是"协议上发生了什么"——这是 v1 完全没有的一层。

> **坑（实现时踩过）**：**回合内产生的 `mark` 必须带 `turn_seq`**。
> `approval/request`、`approval/decision`、`fs/write_applied`、`terminal/created`、
> `protocol/rejected_unknown_method` 都是在某一轮 `session/prompt` 里发生的，
> 漏了 `turn_seq` 会有两个后果：① 看板把它们丢进"会话级"分组，时间线上看不到它们夹在回合中间；
> ② 无法按「同回合 + 同方法」归组，被否决清单会为同一件事显示两行。
> 只有真正不属于任何回合的（`host/spawn`、`rules/loaded`、`ws/*`、`index/rebuilt`）才允许为空。

### 5.3 审批 payload（发往看板的实时消息）

```jsonc
{
  "type": "PERMISSION_REQUEST",
  "rpc_id": 11,                   // 看板必须原样回传，用于配对
  "method": "terminal/create",
  "risk_level": "HIGH",
  "reason": "执行命令：git status --short -- .",
  "timeout_ms": 60000,
  "expires_at": 1789459489000,    // 比 timeout_ms 更好用：看板可直接显示倒计时
  "options": [                    // 来自 agent；看板必须渲染这些选项本身
    { "optionId": "allow-once",   "name": "允许一次",   "kind": "allow_once" },
    { "optionId": "allow-always", "name": "本轮都允许", "kind": "allow_always" },
    { "optionId": "reject-once",  "name": "拒绝",      "kind": "reject_once" }
  ]
}
```

看板回传：`{ "type": "permission_decision", "rpc_id": 11, "optionId": "allow-once" }`

### 5.4 Diff 必须由宿主计算

ACP **没有补丁方法**，`fs/write_text_file` 是整文件替换。所以：

- 宿主在写盘前读取旧内容、写盘后保留新内容，两份都存进 `snapshots/`；
- 用行级 LCS 算 unified diff，存进 `diffs/`；
- 响应体里通过 `_meta` 回带统计（**用协议允许的 `_meta`，不加顶层字段**）：

```jsonc
{ "jsonrpc":"2.0", "id":4, "result": { "_meta": {
  "diff": { "added": 3, "removed": 0, "hunks": 1 },
  "created": false,
  "diff_file": "diffs/sandbox__scratch__ok.js.diff" }}}
```

大文件保护：行数乘积超过阈值时退化为"整文件替换"的 diff，避免 O(n·m) 爆内存。

### 5.5 落盘布局

```
.agents/trace/<session_id>/
├── events.jsonl        # 每行一个事件，append-only，崩溃安全
├── summary.json        # 会话汇总（错误数、尝试/成功/被拒、未通过的规则）
├── snapshots/          # <扁平化路径>.before / .after
├── diffs/              # <扁平化路径>.diff（宿主自算）
└── sandbox/            # 可选：给 agent 的隔离写入区

.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-主题.md   # 决策笔记（AGENTS.md §4，v3 新增）
```

- 文件名用"相对项目根的路径扁平化"（`/` 与 `\` 替 `__`），会话目录前缀要剥掉，否则会编出
  `.agents__trace__s_xxx__sandbox__...` 这种没法看的长串。
- `.agents/trace/` 建议进 `.gitignore`。**源码与运行产物必须分开**。
- `.agents/notes/` 与 trace **平级、在项目根下**：trace 是运行产物（gitignore），笔记是知识（建议进 git、
  随决策同批提交）。宿主在构建索引时解析并内联进 `index.notes`（§5.8），看板因此不需要第二套读取通道。

### 5.6 反向锚点：代码 → 追溯记录

追溯的价值取决于「从代码能不能回到当初为什么这么写」。所以宿主与看板的代码里要留**反向锚点**，
而且锚点必须能被机械校验 —— 否则改名、换目录、清理产物之后它会静默失效，比没有更糟。

写法（放在函数上方的 JSDoc 里，两类可同时出现）：

```js
/**
 * ...这段实现的关键取舍...
 *
 * @see [SPEC §4.3 审批流程与默认值](SPEC.md#43-审批流程与默认值)      ← 文档锚点：路径相对当前文件
 * @trace s_20260915-160302_1908bc#34 实测：看板点拒绝后，磁盘上确实没有那个文件
 *                                                                  ← 追溯坐标：<session_id>#<seq>
 */
```

校验规则（`check-trace-anchors.mjs`，也是合规检查器 `TRACE_NOTE_ANCHORS`）：

| 锚点 | 判定 |
|---|---|
| `@see [文字](路径)` | 路径（相对当前文件，忽略 `#fragment`）必须存在，否则 **FAILED** |
| `@trace <session>#<seq>` | 会话产物在本机 → 该 seq 必须存在，否则 **FAILED**；不在本机 → **SKIPPED**，不算失效 |
| 文件里写了 `@anchors-skip` | 整个文件跳过（给"注释里放格式示例"的文件用，如校验器自身） |
| 非注释行里的 `@see`/`@trace` | 不算锚点（避免把字符串示例当真） |

**为什么"会话不在本机"必须算跳过**：`.agents/trace/` 是运行产物、不进仓库，
别人的 clone 里根本没有它。要求它存在会让校验变成噪音，最后被人关掉。

三条执行路径：
1. **写 `.js/.mjs` 时自动查这一个文件** —— 由 agent 的动作触发，即时反馈；
2. **`--preflight-anchors` 全仓扫描** —— 不依赖 agent 动作的兜底，适合接进 CI；
3. **`TRACE_WHY_ANCHORED`（WARN，v2 新增）** —— 上两条只能保证**已有**锚点不腐烂，管不住覆盖率：
   锚点没写就是没有。`AGENTS.md §1 反向锚点`把"写码即留痕"定成行为规范后，评估器对**本次新增**的
   "为什么"注释做覆盖提醒（就近 3 行内无锚 → WARN）。只看新增行不看存量——改造旧文件时不能被
   历史欠账刷屏，宁可漏报；锚点必须挂在产生决策的那次会话里，事后考古要翻整个 trace 库。

**条件式锚点（2026-09-16 补）**：`@trace` 的前提是「会话坐标在手」，而这只在宿主链路成立。
宿主拉起 agent 时注入 `SPARK_TRACE_SESSION`（会话 id）与 `SPARK_TRACE_DIR`（本会话 trace 目录）两个
环境变量——这是宿主存在性的**唯一机械检测通道**：session/new 的 `_meta.sparkTrace` 只到协议层，
多数 agent CLI 不会把它透给模型。检测为空（直开的客户端会话）时**禁止写 `@trace`**：指向不存在
会话的锚点只静默 SKIPPED，等于留假锚点；此时降级为决策笔记（`AGENTS.md §4`）+ `@see` 文档锚点，
并在回复里如实声明「本轮未过宿主，无协议留痕」。判路与坐标获取流程沉淀在
`.agents/skills/trace-anchor/SKILL.md`（该目录也在校验默认根里，技能自身受同一契约约束）。

### 5.7 错误码

| 场景 | 码 |
|---|---|
| 方法未登记 / 方向不对 | `-32601` |
| 缺必需参数 | `-32602` |
| 宿主内部错误 | `-32603` |
| 越界路径 / 审批未通过 | `-32001`（自定义，须在文档里声明） |
| 目标不存在 | `-32002` |

### 5.8 看板入口索引（`index.json`）与 digest schema

`trace-index.mjs` 产出的 `index.json` 是看板四种数据来源（§7.2 / 附录 A2）共用的入口契约。
它不在 §5.5 的会话目录里，而在 trace 根：`.agents/trace/index.json`。schema 版本号写在顶层
`schema` 字段 —— **破坏性变更才 bump**（字段删除/改名/语义反转）；加新字段不算破坏，
看板按「未知字段防御性忽略」消费。

顶层字段：

| 字段 | 说明 |
|---|---|
| `schema` | 本表版本，当前 `1`。看板读到高于它认识范围的值时**照常载入**、只做降级提示 —— 拒载会把新宿主产物变成不可读，违背归档通道「任何时候可看」 |
| `kind` | `spark-trace-index`（索引）/ `spark-trace-bundle`（`--bundle` 自包含单文件） |
| `project_path` / `generated_at` / `trace_root` / `entry` | 环境信息 |
| `notes[]` | **决策笔记**（AGENTS.md §4），构建期从 `.agents/notes/` 解析并内联正文；`notes_root` 固定 `.agents/notes`，`notes_truncated` 标记超上限截断 |
| `sessions[]` | 会话条目，按 `started_at` 倒序 |

笔记条目字段（`trace-index.mjs` 的 `parseNoteText`，看板目录授权模式在 `source.js` 有同构解析，改字段两边一起改）：
`id`（文件名 stem，即锚点 `yyyy-mm-dd-主题`）、`file`（相对项目根）、`status`（proposed/implemented/rejected/archived，
取自一级目录）、`category`（六枚举，取自二级目录）、`date`（stem 前十位）、`title`（`# Agent Note:` 行，缺行用 id 兜底）、
`body`（内联正文，单篇 16KB 封顶，超出置 `truncated`）、`refd_by[]`（哪些笔记的正文提到本篇 stem —— 被引用血缘）、
`links[]`（本篇正文提到的其它笔记）。**引用口径**：按篇去重的 stem 文本匹配——stem 含日期+主题全库唯一，
是相对链接的可靠代理，与 pitfalls 的会话去重同理。合规域的笔记格式校验见 §6.1 `AGENT_NOTE_FORMAT`。

会话条目字段：`session_id`、`dir`（trace 根下的目录名）、`started_at`/`ended_at`、`project_path`、
`policy`、`stop_reason`、`rules_source`、`rules_sha256_16`、`counts`（尝试/落盘/命令等计数）、
`errors`（`protocol` / `compliance_failed` 两个计数）、`failed_rules`、`protocol_error_methods`、
`files`（`events` / `summary` / `diffs` / `snapshots`，**一律相对 trace 根**）、`diffs_inline`、
`diffs_inline_truncated`、`events_count`、`digest`。

digest（宿主一次算好的跨会话摘要；看板四个聚合模块只靠它，避免 HTTP 模式 N+1）：

| 键 | 说明 |
|---|---|
| `heavy_files[]` | `{path, rel, dir, writes}`。`rel` 是**剥掉会话目录前缀**的路径 —— 看板按它聚合，否则同一份文件在每个会话里各算一条 |
| `rule_tally[]` | 每条规则的 total / passed / failed / skipped / error 五桶 |
| `compliance_failed[]` | FAILED / ERROR 的合规结果（target 从 parent 的参数里解出） |
| `denied[]` | 被否决。**双记录**：`kind: 'permission'`（审批被拒）与 `kind: 'blocked'`（`-32001` 被拦）各记一条 —— §4.5 的接缝，看板按「同回合 + 同方法」归组 |
| `protocol_errors[]` | 协议错误（含 v1 错名提示） |
| `capabilities` | `initialize` 协商结果：protocol_version / client / agent / agent_info |
| `truncated` | 上面四个数组各自是否被 `DIGEST_CAPS` 截断；看板应露出截断标记 |

写入纪律（宿主侧，防看板读到半截）：

1. **原子写**：`index.json` 与 bundle 都必须 tmp+rename（`trace-index.mjs` 的 `writeAtomic`），
   禁止原地覆盖 —— 宿主每轮会话结束都重建索引，看板随时并发读，「会话刚跑完点开看板」恰好
   撞上覆盖窗口就会拿到半截 JSON。
2. **diffs_inline 封顶**：每会话内联进索引的 diff 条数有上限（`DIFF_INLINE_MAX`），超出只记
   `files.diffs` 路径并置 `diffs_inline_truncated: true`；看板 `loadDiff` 自动回落到按路径读。
   bundle 模式不受此限（单文件必须自包含）。
3. **枚举同步**：合规状态枚举（§6.2）扩张时，看板侧唯一权威表是 `trace-board/0.1.0/analyze.js`
   的 `COMPLIANCE_STATUS`（label / cls / rank 一表派生）；两侧由
   `trace-board/tests/contract-test.mjs` 机械核对，漏改即红。

---

## 6. 合规评估器

### 6.1 规则表（`rule_source` 必须指向真实存在的小节）

| `rule_id` | `rule_source` | 触发 | 判定 |
|---|---|---|---|
| `AGENTS_MD_SEC_2_EXTRACTION` | `AGENTS.md §2 触发阈值` | 写 `.html` | 内联 `<style>`/`<script>` 任一超 **100 行** → 红；HTML 总行数超 **300 行** → 红 |
| `AGENTS_MD_SEC_2_SYNTAX` | `AGENTS.md §2 提取做法第 4 条` | 写 `.js/.mjs/.cjs` | 跑 `node --check`，非 0 退出 → 红 |
| `AGENTS_MD_SEC_3_HARDENING` | `AGENTS.md §3 其它硬性约束第 1 条` | 写插件页面（`<版本号>/index.html` 或 `page.*` / `app.js`） | 必须同时存在：禁右键菜单、拦 F12/F5、拦 Ctrl+P；缺任一 → 红并列出缺失标记 |
| `TRACE_NOTE_ANCHORS` | `AGENTS.md §1 ACP 规范（留痕要求）` | 写 `.js/.mjs` | `@see` 指向的文件必须存在；`@trace` 的会话#序号必须能在 `.agents/trace` 里找到（会话不在本机 → 跳过不算失效）。判定细节见 §5.6 |
| `TRACE_WHY_ANCHORED` | `AGENTS.md §1 ACP 规范·反向锚点` | 写 `.js/.mjs` | **WARN 级**：本次**新增**的"为什么"注释（强信号词判定，见 `compliance.mjs` 的 `checkWhyAnchored`）就近 3 行内没有 `@trace`/`@see` → 提示补挂；不拦盘、不计入合规失败 |
| `AGENT_NOTE_FORMAT` | `AGENTS.md §4 决策笔记` | 写 `.agents/notes/**.md` | 路径 = `{lifecycle}/{class}/yyyy-mm-dd-主题.md`（4×6 枚举）；骨架：`# Agent Note` 标题行 + 与目录一致的 `Status:`/`Class:` 行 + 四节（背景/决策/放弃方案/代价与后果） |
| `SPARK_RELEASE_INTEGRITY` | `AGENTS.md §3 发布物完整性` | 显式触发（`--preflight <插件版本目录>`） | 见 §6.5 |

**评估器必须可枚举**：代码里要导出一份规则元数据（`rule_id` / `rule_source` / `trigger` / `detail`），
看板才能显示"当前挂载了哪些检查器"。v1 没提这一点，导致"自动挂载"变成黑盒。

### 6.2 状态枚举（五种，v1 只有一种）

| 状态 | 含义 |
|---|---|
| `PASSED` | 检查执行且通过 |
| `FAILED` | 检查执行且不通过 |
| `WARN` | 检查执行且通过，但有改进提示（如 `TRACE_WHY_ANCHORED` 的"新增注释未挂锚"）；**不计入合规失败** |
| `SKIPPED` | 规则对该文件不适用（如对 `.js` 跑 HTML 行数规则） |
| `ERROR` | 检查器自身失败（如 `node --check` 找不到可执行文件） |

### 6.3 判定顺序

先判"是否适用"（→ `SKIPPED`），再判超阈值。同级规则命中多条时**全部上报**，不要只报第一条。

### 6.4 语法校验的一个真实陷阱

`node --check` 依据**最近的 `package.json`** 决定模块类型。目录里没有 `package.json` 时 `.js` 按
CommonJS 解析——**此时文件里出现顶层 `export` 会被判为语法错误**。写自检样例时要注意，
否则会把"语法正确"的文件判红。

### 6.5 发布物完整性（N−1）

```
git ls-files <插件版本目录>         → 得到追踪文件数 N
signature.json 的 files 数组长度   → 得到清单条数 M
判定： N − 1 == M                  # 减 1 是 signature.json 自身
```

**不是比对"二进制文件数量"**（v1 的措辞不准确）。实测 `hosts-switcher/0.1.0`：N=9、M=8，通过。
不一致说明有文件没进 git，而市场走 zipball、缺文件会在双向校验时拒装——所以这条必须在提交前跑。

---

## 7. 看板 UI 规格

### 7.1 技术栈（必须定死，不许 "A 或 B"）

- **宿主**：Node.js ≥ 20，ESM，**零第三方依赖**。
- **看板**：**单文件 HTML + 原生 JS + 原生 CSS**，无框架、无构建、无 CDN 依赖。
  理由：归档通道的目标就是"离线、可双击打开、可打包分发"，引入框架与构建会直接摧毁这个目标。
  若团队强制要求框架，**只能二选一并删掉另一个选项**，且必须同时交代构建产物如何离线分发。
- 看板源码遵守本仓库 `AGENTS.md §2`：`index.html` / `style.css` / `app.js` 三件套，
  JS 超 600 行再按职责拆。

### 7.2 两种运行模式

| 模式 | 数据来源 | 能力 |
|---|---|---|
| **归档模式**（默认） | 用户授权的 trace 目录（File System Access API `showDirectoryPicker()`） | 全部历史回看、Diff、合规结果、血缘 |
| **实时模式** | 实时通道 WebSocket | 追加：审批弹窗、流式轨迹 |

- 归档模式**不需要任何后端**，也不该依赖实时通道。
- File System Access API **仅 Chromium 系支持**（Chrome / Edge）。Firefox、Safari 没有该 API，
  必须提供降级：由宿主 `--bundle` 导出一个内嵌数据的单文件 HTML。
- 若看板需要跑在 IDE 的 webview 里，改用自建桥（webview ⇄ 本地进程）而不是该 API。

### 7.3 模块信息架构（v3：决策笔记驱动，无笔记回落 trace 视图）

v1 把三条不同粒度的信息塞进同一个 Left Panel；v2 按"问题"分了块但只有 trace 数据；
v3 把**决策知识**提为第一公民——四个聚合模块优先展示 `index.notes`，运行时事实做副行与对照，
没有笔记的索引自动回落到纯 trace 视图，两套形态共享同一组类名与左轨「统计范围」：

| 模块 | 回答的问题 | 有笔记时 | 无笔记回落 |
|---|---|---|---|
| **架构基线** | 现在正在生效什么 | KPI 四卡（已落地/待评审/避坑否决/归档，副行=落盘/会话/被拦/合规）→ 承重墙笔记卡（被引用 ×N）→ 分类面板（六类 chamber）→ 规则指纹与能力 | KPI 换成 trace 四卡；承重墙回落文件条形视图；分类回落目录卡片 |
| **演进时间线** | 什么时候动了什么 | 左轨每卡节点圆环，**决策笔记与会话执行合并按月分组，日期沉进卡内药丸**（笔记=日历+完整日期，会话=时钟+日 时:分:秒）；月份切片 + 类型切片（全部/决策笔记/会话执行） | 纯会话条目同轨道渲染 |
| **避坑智库** | 想过什么、放弃了什么 | rejected 笔记 → 三块卡（❌ 放弃备选 / 💡 权衡依据 / ✅ 采纳结果）+ 运行时拦截六列表 | 纯运行时拦截表 |
| **决策清单** | 全库决策总表 | 笔记六列表（编号/分类/标题/状态/日期/引用）+ 状态切片 | 会话六列表（编号/分类/标题/状态/日期/改动） |
| **会话详情** | 单会话深看 | 子页签：时间线（血缘缩进+原始 JSON-RPC）/ 改动 Diff / 合规自检 / 被否决 | 同左（这是 trace 的主场） |

- 笔记卡/行点击 → **笔记详情宽抽屉**：标签行（分类/状态/锚点 id）+ 四节正文 + 被引用/引用了这些笔记（可跳转）+ 文件路径。
- 顶栏**全局搜索**（`/` 聚焦）按标题+id+正文过滤笔记类视图；`refd_by` 由宿主构建期算好（§5.8）。
- 「被否决清单」从 v2 的建议项落成两个实体：**rejected 笔记**（人的取舍）与**运行时拦截**（协议事实）。

### 7.4 审批弹窗

- 渲染 agent 给的 `options`（§5.3），不要自造 Approve/Reject。
- 显示 `risk_level`、`reason`、由 `expires_at` 换算的倒计时。
- 超时后 UI 必须切到"已按默认拒绝处理"的终态，而不是无限等待。
- 无选项的方法显示"本次由宿主策略判定（allow / deny）"，让用户知道决定权不在自己手上。

### 7.5 渲染安全

- Diff、报文、命令输出全部是**不可信内容**，注入 DOM 前必须转义（用 `textContent`，不要 `innerHTML`）。
- 长输出做截断并在 UI 上标明截断。
- 看板**不执行**任何来自 trace 的内容。

### 7.6 视觉基线（v3，参考 write-notes-like-deepseek 工程决策看板）

- **基调**：浅色优先（`#F8FAFC` 底 + 28px 双向 1px 微网格纹理 + 白卡片大圆角柔和分层），深色为等权切换项；
  网络字体不可用（无 CDN），display/body 走系统栈近似。
- **顶栏**：64px 玻璃（blur + 0.88 白）；品牌 = 32×32 深底方块 + 8px 蓝点 + 计数徽标（N 篇笔记 · M 会话）；
  居中药丸页签组（激活白底 + 2px 品牌蓝下划线）；右侧全局搜索（聚焦展宽 + 蓝框 glow + `/` 快捷键标签）。
- **分类色板**（六类固定，浅色 底/字/边）：architecture `#FFF7ED/#C2410C/#FED7AA`、feature `#EFF6FF/#1D4ED8/#BFDBFE`、
  bug-fix `#ECFDF5/#047857/#A7F3D0`、simplification `#F0FDFA/#0F766E/#99F6E4`、process `#FAF5FF/#7E22CE/#E9D5FF`、
  testing `#FDF2F8/#BE185D/#FBCFE8`；状态徽章：implemented 绿 / proposed 琥珀 / rejected 红 / archived 灰。
- **KPI 卡**：大数字 + 底边 3px 强调条 + 右上状态点，hover 上移 2px。
- **轨道时间线**（参考站式）：2px 竖向渐变轨线 + 月组头「YYYY-MM · N 条」徽章与实心起点点 + 每卡 12px 节点圆环（卡片伪元素）+ 卡内日期药丸；hover 提亮边框与节点，不做位移。
- **避坑三块**：左缘 3px 实线色块（danger/amber/ok），标题行 + `pre-wrap` 正文。
- 无障碍底线：可点元素必须有可见焦点态（outline + focus-ring）；状态色必须配 6px 状态点做图形锚点（色弱可扫读）。

---

## 8. 实现验收清单

每条都可机械核对。参考 `.agents/runner/` 已全部通过。

| # | 验收项 | 判定方式 |
|---|---|---|
| 1 | 生命周期完整 | trace 里能依次看到 `initialize` → `session/new` → `session/prompt` 三条 `client->agent` request |
| 2 | 未知方法不挂起 | 让 agent 发 `tools/call`：必须收到 `-32601`，且 trace 里有 `protocol/rejected_unknown_method` |
| 3 | 方向校验 | 把某个反向方法的 `dir` 改错，必须被标 `protocol.status = ERROR` |
| 4 | 规则注入合规 | `session/new` 的 `_meta` 带规则指纹；`session/prompt` 的 `content` 里能看到 `resource` 块 |
| 5 | 三条阈值都能红 | 造 319 行 HTML、131 行内联 `<style>`、语法坏的 JS，三条必须分别 `FAILED` |
| 6 | 加固规则双向 | 带加固段的插件页面 `PASSED`，缺的 `FAILED` 且列出缺失标记 |
| 7 | 拒绝真的生效 | `--policy deny` 跑一轮，落盘文件数必须为 **0** |
| 8 | 实时审批可拦 | 看板交替批复：放行的落盘，**被拒的新建文件不存在、被拒的修改保持改前版本** |
| 9 | 鉴权有效 | 不带 token 的 WS 升级请求必须被 `401` |
| 10 | 超时默认拒绝 | 断开看板后触发审批，必须按拒绝处理并留痕 |
| 11 | 归档可独立消费 | 只用 `events.jsonl` + `diffs/` 就能生成完整报告，不需要实时通道 |
| 12 | N−1 核对 | 对任一已签插件目录跑，`git ls-files` 条数 − 1 == `signature.json` 清单条数 |
| 13 | 汇总不混淆尝试与成功 | `summary.json` 里写盘必须分 `attempts` / `applied` 三个数，不能只有一个 |
| 14 | 反向锚点不腐烂 | `node .agents/runner/check-trace-anchors.mjs` 退出码 0；把某个 `@see` 改成不存在的路径，必须报 FAILED；把 `@trace` 的 seq 改成 999999，必须报 FAILED；指向不存在会话的锚点必须算 SKIPPED 而不是 FAILED |
| 15 | 锚点口径一致 | 代码里的 `@trace` 指向的 seq，必须真能在对应会话的 `events.jsonl` 里找到（不是"记忆里的那一次"） |
| 16 | 决策笔记格式闸（v3） | 写一篇缺节/Status 与目录不符的笔记 → `AGENT_NOTE_FORMAT` FAILED 且列出缺失项；合格骨架 → PASSED |
| 17 | 笔记进索引与血缘（v3） | 重建索引后 `index.notes` 收到该篇；另一篇正文提到它的 stem → `refd_by` 计到；看板承重墙出现「被引用 ×N」，点卡开详情抽屉 |
| 18 | 看板健康度（v3） | `node trace-board/tests/ui-smoke.mjs` 83 项全绿；`node trace-board/tests/contract-test.mjs` 13 项全绿（SPEC §6.2 ↔ 看板表 ↔ runner 字面量三方对拍） |

---

## 9. 明确不做 / 已知缺口

- **审批与后续调用无关联字段**（§4.5）——需要协议扩展或启发式配对，不是 bug，是缺口。
- 未实现：`session/cancel` 的主动取消、`session/load|resume|list`、`elicitation/create`。
- 写盘只做整文件替换（协议如此），不做按行 patch。
- 路径白名单只到"工作区内 + 排除 `.git/` 与宿主自身"，未做细粒度规则引擎。
- `agentThoughtChunk` 依赖 agent 主动发送。**若 agent 不发思考块，看板该区域就是空的**——
  UI 必须容忍并显示"本轮 agent 未上报思考"，而不是假装在加载。
- 未做多会话并发与跨会话检索（单会话单进程）。
- **笔记"死链不过夜"未自动化**（v3 缺口）：索引只按 stem 文本匹配统计引用（§5.8），不校验相对链接
  目标是否存在——归档/改名后的死链要靠人与归档清单，`AGENT_NOTE_FORMAT` 也不查它。
- 笔记正文是 markdown 明文按节渲染，**不解析行内标记**（加粗/链接在详情抽屉里按纯文本展示）。

---

## 10. 附录

### 附录 A · 文件清单（参考实现）

| 文件 | 职责 |
|---|---|
| `host.mjs` | 宿主：拉进程、跑生命周期、拦副作用、落盘、广播 |
| `acp-methods.json` | 方法清单 + 方向 + 必需参数 + v1 错名勘误（宿主校验依据） |
| `trace.mjs` | 追溯写入器：seq / parent_seq / 协议校验 / 汇总 |
| `compliance.mjs` | 合规评估器 + 风险判定 + N−1 核对 |
| `diff.mjs` | 自算 unified diff（LCS） |
| `ws.mjs` | 零依赖 WebSocket 服务端（127.0.0.1 + token） |
| `mock-agent.mjs` | 测试替身：离线可测的 agent，故意发出该被拦的内容 |
| `approver.mjs` | 看板侧审批客户端（测试替身） |
| `trace-report.mjs` | 归档读取端：人读时间线 + 血缘树；有未通过则非零退出 |
| `trace-index.mjs` | 生成看板入口索引 `index.json`，并支持 `--bundle` 导出自包含单文件 |
| `SPEC.md` | 本文 |

### 附录 A2 · 看板的参考实现

`trace-board/0.1.0/`（本仓库的 Spark 插件，webview 形态）。它落实了 §7 的三条硬要求，
也补上了 §1.1 归档通道的可用性证明：

- **三种数据源**：选项目目录（`File API`，无需授权）／按绝对路径读（`spark.fs.read`，需授权目录范围）／
  HTTP 远程库（`spark.net.fetch`）／粘贴 JSON。
- **两处宿主约束**直接决定了它的架构，改实现前先读：
  1. 插件页**不能直接出网**（引擎拦掉页面内一切 http/https），唯一出网通道是 `spark.net.fetch`；
  2. `spark.fs` **只有 read/write，没有目录列举** —— 所以「按路径读」必须有入口索引文件，
     这也是 `trace-index.mjs` 存在的理由。
- 页面健康度：CDP 冒烟 83 项（`trace-board/tests/ui-smoke.mjs`）、枚举契约测试 13 项
  （`trace-board/tests/contract-test.mjs`）、图标几何自检 13 项（`trace-board/tests/icon-test.mjs`）。
  入口索引（含决策笔记）的 schema 契约见 §5.8；视觉基线见 §7.6。

### 附录 B · 术语

- **宿主 / Host**：ACP 语境里的 **Client**（编辑器侧角色），进程上又是 agent 的父进程。
  为避免歧义，本文统一叫"宿主"。
- **反向 RPC**：agent 主动向宿主发起的请求（`fs.*` / `terminal.*` / `session/request_permission`）。
  拦截能力全部发生在这一侧。
- **turn（回合）**：一次 `session/prompt` 及其引发的全部事件。`turn_seq` 即该 prompt 事件的 `seq`。

### 附录 C · 验收命令（参考实现）

```bash
NODE=node   # 或本机 Node 绝对路径

# 1) 全放行跑一轮（离线，内置 mock agent）
$NODE .agents/runner/host.mjs --mock --policy allow --ws-port -1
#    期望：事件 ~143 · 合规未通过 4 条（三件套阈值 ×2、语法 ×1、加固 ×1）
#          写盘 尝试 9 · 落盘 9（含 2 篇决策笔记进 .agents/notes/）· 命令 1/1

# 2) 追溯报告（有未通过则退出码 1，可作 CI 闸门）
$NODE .agents/runner/trace-report.mjs
#    期望：能看到生命周期三阶段、协议错误带 v1 错名提示、审批明细、血缘树

# 3) 实时审批（两个终端）
$NODE .agents/runner/host.mjs --mock --policy ask --ws-port 9101 --token demo --wait-dashboard-ms 9000 &
$NODE .agents/runner/approver.mjs "ws://127.0.0.1:9101/?token=demo" alternate
#    期望：10 次批复（交替 5 放行 / 5 拒绝）；写盘 尝试 9 · 落盘 5 · 被拒 4；命令被拒未执行
#    关键核对：被拒的【新建】写盘不产生文件；被拒的【修改】保持改前版本，追加内容不落盘
#    （别写成"被拒的文件一定不存在"——改已有文件时它本来就存在）

# 4) 全拒绝（验证副作用确实没发生）
$NODE .agents/runner/host.mjs --mock --policy deny --ws-port -1 --quiet
#    期望：写盘 尝试 9 · 落盘 0 · 被拒 9；sandbox 文件数 = 0

# 5) 发布物完整性
$NODE .agents/runner/host.mjs --mock --policy allow --ws-port -1 --preflight hosts-switcher/0.1.0
#    期望：✓ 清单 8 条 = git 追踪 9 − 1

# 6) 反向锚点不腐烂（可作 CI 闸门）
$NODE .agents/runner/check-trace-anchors.mjs
#    期望：退出码 0；扫描 .agents/runner + trace-board，失效 0（会话不在本机算跳过，不算失效）
#    另带新规则的单元测试：node .agents/runner/tests/why-anchor-test.mjs（16 项）

# 7) 决策笔记链路（v3）
$NODE .agents/runner/trace-index.mjs
#    期望：汇总行带「决策笔记 N 篇」；index.json 顶层有 notes[]（含 refd_by 血缘）
#    另写一篇缺节/Status 与目录不符的笔记过闸 → 合规里 AGENT_NOTE_FORMAT 必须红
#    看板侧：node trace-board/tests/ui-smoke.mjs（83 项）+ node trace-board/tests/contract-test.mjs（13 项）
```
