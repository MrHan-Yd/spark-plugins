---
name: trace-anchor
description: spark-plugins 追溯留痕纪律。写「为什么这么写」注释或拍板非平凡决策时先判宿主存在性：会话在 ACP 宿主（host.mjs）链路上则挂 @trace 会话锚点；直开的客户端会话则禁止 @trace，降级为决策笔记 + @see 文档锚点，并如实声明本轮未留痕。
---

# trace-anchor — 条件式反向锚点

代码里凡解释「为什么这么写」的注释（反直觉实现、被否决方案、实测结论）必须在**写代码的同一会话里**
就近挂锚。但锚点的前提是「会话坐标在手」——这只在宿主链路成立。所以**先判宿主，再选路径**。

## 第 0 步：判宿主存在性

```
node -e "process.stdout.write(process.env.SPARK_TRACE_SESSION ?? '')"
```

- **非空** → 有宿主。`SPARK_TRACE_SESSION` 就是会话 id，`SPARK_TRACE_DIR` 就是本会话 trace 目录，
  走路径 A。
- **空** → 无宿主（直开的客户端会话，不经 host.mjs，协议事件流不存在）。走路径 B。
  **此路径下禁止写 `@trace`**——校验器对指向不存在会话的锚点只静默 SKIPPED，等于留假锚点。

## 路径 A：有宿主

1. **先拿证据再挂锚**：锚点只能指向写锚点那一刻**已落盘**的事件（正在写的文件引用不了自己这次
   写盘的 seq）。实测结论先靠跑命令、读文件等动作产生事件，锚点在**下一次写盘**时挂上去。
2. **挑坐标**：
   ```
   node .agents/skills/trace-anchor/scripts/resolve-coordinates.mjs
   ```
   打印当前 session id、last_seq 和最近 8 条事件（seq + 名称/方法），从里面挑**能证明结论的那一条**。
3. **就近挂锚**（注释内距「为什么」文案 3 行以内，两类可同时出现）：
   - `@trace s_<会话>#<事件序号> 实测：<一句结论>`
   - `@see [SPEC §x.y](相对路径)` —— 决策已沉淀进 SPEC 小节时用；也可指决策笔记。
4. **提交前跑校验**：`node .agents/runner/check-trace-anchors.mjs`，失效即修。

## 路径 B：无宿主

1. **禁止 `@trace`**。
2. 非平凡决策写**决策笔记**：`.agents/notes/<状态>/<分类>/yyyy-mm-dd-主题.md`，规则见仓库
   `AGENTS.md §4`（四状态六分类，Status 行与所在目录一致，与代码同批提交）。
3. 代码注释里的决策点挂 `@see` 文档锚点，指向决策笔记或 SPEC 小节。
4. **在最终回复里如实声明**：「本轮未过宿主，无协议留痕」——看板只见笔记，不见事件流。

## 边界

- 普通「是什么」注释（描述逻辑、标注意义）不需要锚点；只有「为什么」类触发义务。
- `.md` 文件不在机械校验范围，但笔记互链同样不许死链。
- 格式细则与校验契约见 [references/anchor-format.md](references/anchor-format.md)。