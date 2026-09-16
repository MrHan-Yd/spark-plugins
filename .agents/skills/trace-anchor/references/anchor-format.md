# 锚点格式与校验契约

两类锚点，只认 **JS 注释行**（`//`、`/* */`）；非注释行里的字样不算锚点（防字符串示例误报）。
`.md` 文件不参与机械校验，但笔记互链同样不许死链（AGENTS.md §4.3）。

## 1. `@trace` 追溯坐标

```
@trace s_20260916-101829_e11f68#34 实测：看板点「拒绝」后，磁盘上确实没有那个文件
```

- 会话 id 必须等于 `SPARK_TRACE_SESSION`（宿主注入的当前会话），对应
  `.agents/trace/<会话>/events.jsonl`；
- 事件序号必须是写锚点那一刻**已落盘**的 seq——正在写的文件引用不了自己这次写盘的事件。
  所以流程是：先拿证据（跑命令 / 读文件产生事件）→ `scripts/resolve-coordinates.mjs` 挑坐标 →
  下次写盘时把锚挂上去；
- 校验判定：会话在本机 → seq 必须存在，否则 **FAILED**；会话不在本机（别人的 clone）→
  **SKIPPED**，不算失效——`.agents/trace/` 是运行产物不进仓库。**直开客户端会话里写 `@trace`
  = 必然 SKIPPED 的假锚点，禁止。**

## 2. `@see` 文档锚点

```
@see [SPEC §5.6 反向锚点](SPEC.md#56-反向锚点代码--追溯记录)
```

- 路径相对**当前文件**解析，`#fragment` 被忽略、只校验文件存在；目标不存在 → **FAILED**；
- 也接受裸路径形式 `@see ../notes/implemented/process/xxx.md`；
- 合法目标：SPEC 小节所在文件、`.agents/notes/` 决策笔记。

## 校验与豁免

- 收口：`node .agents/runner/check-trace-anchors.mjs`（默认根：`.agents/runner`、`trace-board`、
  `.agents/skills`），有 FAILED 即退出码非 0；宿主 `--preflight-anchors` 同源。
- 覆盖提醒：`TRACE_WHY_ANCHORED`（WARN 级，不拦盘）——新写的 `.js/.mjs` 里「为什么」注释
  就近 3 行内无锚点即提示补挂；只看新增行，存量欠账不刷屏。
- 整文件豁免：注释里放**格式示例**的文件（如校验器自身）在注释里写一行 `@anchors-skip`。

## 无宿主降级路径

`SPARK_TRACE_SESSION` 为空 → 不写 `@trace`；非平凡决策落 `.agents/notes/`（Status 与目录一致、
与代码同批提交），代码注释挂 `@see` 指笔记或 SPEC，最终回复声明「本轮未过宿主，无协议留痕」。
决策背景见 [条件式反向锚点笔记](../../../notes/implemented/process/2026-09-16-条件式反向锚点.md)。