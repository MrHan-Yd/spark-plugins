# AGENTS.md — AI Agent 工作规范

给在本仓库工作的 AI agent 的硬性约定。人类开发者同样适用,agent 必须遵守。

## 1. 插件页面:样式与 JS 必须独立文件

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
   ```bash
   # 以 page.html → page.css / page.js 为例
   awk '/^<style>$/{f=1;next} /^<\/style>$/{f=0} f' page.html > page.css
   awk '/^<script>$/{f=1;next} /^<\/script>$/{f=0} f' page.html > page.js
   # 然后把 <style>…</style> 与 <script>…</script> 块替换为下面的引用
   ```
2. HTML 里改为引用(相对路径,与页面同目录;插件页面以自身目录为根加载):
   ```html
   <link rel="stylesheet" href="style.css">
   <script src="app.js"></script>
   ```
3. 文件命名与上表一致,不发明新名字;不放进子目录。
4. 迁移后自检:JS 过 `node --check <file>.js`;CSS/JS 行数用 `wc -l` 复核。
5. JS 超过 ~600 行且职责可分时继续按职责拆分(先例:code-calc 的 `app.js` + `engine.js`)。

### 仓库内正反例

- ✅ `code-calc/0.1.0/`:index.html 87 行 + style.css 196 行 + app.js 666 行 + engine.js 1210 行
- ✅ `local-search/0.1.0/`:page.html 93 行 + page.css 156 行 + page.js 311 行
- ❌ `compare/0.1.0/index.html`(2801 行)、`json-formatter/0.1.0/index.html`(1163 行):
  历史单文件巨石,**不要求立刻重写**;但 agent 一旦要改它们,先按阈值判断是否顺手提取。

## 2. 其它硬性约束

- 发布物直接在 `<插件>/<版本>/` 目录内迭代;开发阶段**不新建版本目录、不改版本号**。
- 涉及 exe 的改动:`cargo build --release` 后把产物复制进版本目录,文件名与 `plugin.json` 的 `main` 一致。
- 改完页面文件后跑 `node --check` 校验 JS;改完协议/Rust 跑 `cargo run --example smoke` 冒烟。