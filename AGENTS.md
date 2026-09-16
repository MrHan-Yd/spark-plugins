# AGENTS.md — AI Agent 工作规范

给在本仓库工作的 AI agent 的硬性约定。人类开发者同样适用,agent 必须遵守。

## 1. Agent Client Protocol (ACP) 规范

Agent 在处理本仓库的任何任务时，必须遵循以下 Agent Client Protocol (ACP) 交互与控制规范：

- **上下文与能力**：Agent 须通过 initialize 握手识别客户端能力，优先依赖 ACP 动态推送的 Workspace Diff 和环境状态，不向开发者索要已有上下文。
- **修改与工具调用**：修改代码优先输出结构化 Patch/Diff，执行终端命令或文件覆盖等副作用操作须过 ACP 权限中间件校验。
- **异常处理**：发生错误必须按 JSON-RPC 2.0 返回标准 Error Code，禁止静默挂起。
- **反向锚点（写码即留痕，条件式）**：修改 `.agents/runner`、`trace-board`、`.agents/skills` 内的代码时，凡注释里解释
  「为什么这么写」的决策点（反直觉实现、被否决方案、实测结论），必须**在写代码的同一会话里**就近补挂锚点,
  不留到事后考古。**先判宿主存在性**（完整判路与坐标获取流程见 `.agents/skills/trace-anchor/SKILL.md`）:
  - **有宿主**（`SPARK_TRACE_SESSION` 非空——宿主拉起 agent 时注入）: `@trace s_<会话>#<事件序号> 实测：…`
    —— 追溯坐标,指向当前会话 `.agents/trace` 里的对应事件
    （会话进行中 session id 与事件序号就在手上,零成本;会话结束再补就要翻库）;
  - **无宿主**（直开的客户端会话,`SPARK_TRACE_SESSION` 为空）: **禁止写 `@trace`**——校验器对不存在
    会话只静默 SKIPPED,硬写就是假锚点;降级为决策笔记（§4,与代码同批提交）+ `@see` 文档锚点,
    并在回复里如实声明「本轮未过宿主,无协议留痕」;
  - `@see [SPEC §x.y](相对路径)` —— 文档锚点,决策已沉淀进 SPEC 小节时用。
  格式与校验收口在 `.agents/runner/check-trace-anchors.mjs`,提交前跑一遍,失效即修;
  宿主对「新增解释性注释但未挂锚」会按 WARN 提示（`TRACE_WHY_ANCHORED`,不拦盘,但要处理）。

## 2. 插件页面:样式与 JS 必须独立文件

插件页面(webview 的 `index.html`、native 的 `page.html`)是**结构文件**,
不允许长成内联 `<style>`/`<script>` 的单文件巨石。标准三件套:

| 插件形态 | 结构 | 样式 | 脚本 |
|----------|------|------|------|
| webview(`main` 指 HTML) | `index.html` | `style.css` | `app.js`(继续变大时按职责再拆,如 `engine.js`) |
| native(`page` 指 HTML) | `page.html` | `page.css` | `page.js` |

### 触发阈值(满足任一就必须提取)

- **新写页面**:一律三件套起步,不写内联巨石。
- **改造既有单文件页面**:内联 `<style>` 或 `<script>` 任一超过 **100 行**,
  或 HTML 总行数超过 **300 行**,必须先提取再继续改。
- **增量修改**:给单文件页面本次新增样式/脚本超过 **50 行**时,先把存量提取出来,
  不允许在巨石上继续堆。

### 提取做法

1. **机械抽取,禁止手抄**——用脚本按块抽出或整段复制原文,保证内容与原文件逐字一致:

        # 以 page.html → page.css / page.js 为例
        awk '/^<style>$/{f=1;next} /^<\/style>$/{f=0} f' page.html > page.css
        awk '/^<script>$/{f=1;next} /^<\/script>$/{f=0} f' page.html > page.js
        # 然后把 <style>…</style> 与 <script>…</script> 块替换为下面的引用

2. HTML 里改为引用(相对路径,与页面同目录;插件页面以自身目录为根加载):

        <link rel="stylesheet" href="style.css">
        <script src="app.js"></script>

3. 文件命名与上表一致,不发明新名字;不放进子目录(例外:`pdf-toolkit` 的 JS 已由 owner
   归档到 `js/` 子目录,见下方正例)。
4. 迁移后自检:JS 过 `node --check <file>.js`;CSS/JS 行数用 `wc -l` 复核。
5. JS 超过 ~600 行且职责可分时继续按职责拆分(先例:code-calc 的 `app.js` + `engine.js`)。

### 仓库内正反例

- ✅ `code-calc/0.1.0/`:index.html 87 行 + style.css 196 行 + app.js 688 行 + engine.js 1210 行
- ✅ `local-search/0.1.0/`:page.html 93 行 + page.css 156 行 + page.js 390 行
- ✅ `pdf-toolkit/0.1.0/`:index.html 359 行 + style.css 403 行 + js/(app.js 597 + tools.js 591
    + merge.js 410 + engine.js 938 + convert.js 554;JS 已归档 `js/` 子目录——owner 2026-09-08 决定,
      本插件例外于"不放进子目录",页面引用 `js/*.js`)(外壳/工具/合并编辑器/引擎/转换五层拆分)
- ❌ `compare/0.1.0/index.html`(2823 行)、`json-formatter/0.1.0/index.html`(1185 行):
  历史单文件巨石,**不要求立刻重写**;但 agent 一旦要改它们,先按阈值判断是否顺手提取。

## 3. 其它硬性约束

- 新插件页面一律带「页面加固」段(禁默认右键菜单 + capture keydown 拦 F12/F5/Ctrl+P/Ctrl+Shift+I|J|C,
  Ctrl+R 非编辑焦点才拦;input/textarea 豁免右键拦截):代码模板见 `docs/插件开发/WebView插件开发.md` §12
  与 `Native插件开发.md` §12,参考实现 `hosts-switcher/0.1.0/page.js`「页面加固」段。
- **发布物完整性:提交前后必须机械核对,exe/二进制资源是重灾区**(local-search 的 exe、pdf-toolkit 的
  179 个 cmaps、hosts-switcher 的 exe 都实际漏过/差点漏):
    1. `git add <插件>/0.1.0/` **整目录添加,禁止挑文件**——exe、bcmap、字体、vendor 等二进制一律随目录进;
    2. add 后 `git status --short` 该目录**必须干净**(无 `??` 残留);exe 是最常漏的单件,另跑
       `git ls-files <插件>/0.1.0/*.exe` 确认非空(native 插件);
    3. 提交后核对数量:`git ls-files <插件>/0.1.0` 条数 **减 1**(signature.json 自身)= 包内
       `signature.json` 清单条数,不一致必须补提交——市场走 master zipball,缺文件会在 zipball 双向
       校验时拒装;
    4. 运行时产物(如 `0.1.0/backups/`)不进 git,规则在 .gitignore 维护。
- 发布物直接在 `<插件>/<版本>/` 目录内迭代;开发阶段**不新建版本目录、不改版本号**。
- 涉及 exe 的改动:`cargo build --release` 后把产物复制进版本目录,文件名与 `plugin.json` 的 `main` 一致。
- 改完页面文件后跑 `node --check` 校验 JS;改完协议/Rust 跑 `cargo run --example smoke` 冒烟。

## 4. 决策笔记 (Agent Notes)

§1 反向锚点管「代码内为什么这么写」;本节管**跨会话可检索的决策知识**——拍板、妥协、裁剪
要落成结构化笔记,让追溯看板能按分类/状态/引用聚合。谱系:write-notes-like-deepseek
(DeepSeek Harness 的 Agent Notes 实践)。宿主会把 `.agents/notes/` 解析进追溯索引,看板直接展示。

### 4.1 什么时候写 (命中任一即"非平凡";判不准时从严)

- **必写**:改动涉及行为/架构/跨文件契约/流程工具链/测试策略/落盘·网络·配置格式;推翻或取代旧决定;写复盘。
- 三向自查:**立新规**(新契约/边界/运行时不变量)、**记妥协**(为看不见的约束放弃了主流或直觉解法)、**做减法**(破坏性重构/裁剪/API 收窄)。
- **禁写**(直接改代码):纯格式化、错别字、无歧义重命名、不改行为的样式/依赖补丁、单模块内看 diff 即懂的修复。
- 对话信号:拍板("就选 X")、比较中("X 和 Y 怎么选")、同一段理由被解释第二遍。

### 4.2 路径即状态,路径即分类

    .agents/notes/{proposed|implemented|rejected|archived}/{feature|bug-fix|simplification|architecture|process|testing}/yyyy-mm-dd-主题.md

- 状态四个 lifecycle:`proposed` 方案稿 / `implemented` 已落地(与代码同批提交) / `rejected` 审慎否掉(防重犯才留) / `archived` 封存只读。
- 分类六个枚举**不许自造**;转状态 = git mv 挪目录,不改文件名。
- **文件名即锚点 id**(`yyyy-mm-dd-主题`),别的笔记用相对链接指它,代码用 `@see` 指文件(§1)。

### 4.3 笔记骨架 (compliance 的 AGENT_NOTE_FORMAT 规则会机械校验)

    # Agent Note: <一句话标题>
    Status: implemented
    Class: architecture

    ## 背景
    ## 决策           ← 现在时,写"是什么",不写"我们考虑过"
    ## 放弃方案        ← 先写它最强的理由,再写为什么仍然不用
    ## 代价与后果      ← 收益和代价都要写

- `Status:`/`Class:` 行必须与所在目录一致;proposed 稿与 implemented 篇互链,施工完同批转正。
- 笔记互链死链不过夜;可在正文写 `Trace: s_<会话>#<序号>` 关联当次追溯事件。
- 笔记落盘后顺手重建看板索引:`node .agents/runner/trace-index.mjs`——看板读的是 index.json,
  不重建就看不到新笔记(宿主会话收尾会自动重建,这条主要管直开的客户端会话)。