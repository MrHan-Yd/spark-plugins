# Agent Note: Markdown 查看器链接四分流与 shell.open 收口
Status: implemented
Class: architecture

## 背景
markdown 是不可信输入。渲染后的 `<a href>` 可能是 http(s) 外链、`#锚点`、站内相对 .md、`file://`/本地路径，甚至 `javascript:`。宿主 `spark.shell.openExternal` 能用系统默认程序打开 URL/文件——如果 md 作者写 `[点我](D:\evil.exe)` 而插件把 href 原样透传给 openExternal，就是「注入 → 默认程序打开 exe」的 RCE 路径。

## 决策
`engine.js classifyLink()` 四分流，在消毒后 DOM 上执行：

1. **external**（`http(s)://`）→ 点击经 `spark.shell.openExternal`（系统默认浏览器）；
2. **anchor**（`#xxx`）→ 页内滚动（GitHub 兼容 slug，见另一条笔记）；
3. **internal**（相对 .md/.markdown/.mdx）→ 应用内跳转：fs 通道 `dir(当前文件)+href` 再走 fs.read；目录通道查文件表；单文件通道 toast 降级引导选目录；
4. **dead**（file://、ftp、javascript:、data:、mailto:、协议相对 `//host`、相对非 md）→ 替换为不可点 `<span class="dead-link">`（title 弱提示目标）。

安全红线：**openExternal 只收 external 类（http/https）**，且 href 必须取自 DOMPurify 消毒后的 DOM——`javascript:` 等 scheme 另由 DOMPurify 默认 ALLOWED_URI_REGEXP 拦截。app.js 事件委托处再按 `data-link` 二次确认，双保险。

## 放弃方案
- 透传一切 href 给 openExternal（最强理由：用户「点了想打开的东西都打开」体验最顺）。仍然不用：等价于把默认程序执行权交给任意 md 作者，红线。
- 学 linux-command 把所有链接降级 span（最强理由：最安全、零攻击面）。仍然不用：那是受控文档库的档位；通用查看器砍掉外链等于砍掉文档跳转的基本功能。折中：外链放行但只限 http(s)。

## 代价与后果
- 本地文件链接（如 md 引用的兄弟 pdf）不可点——显示为灰 span，用户需自行在资源管理器打开（接受；一期不做文件代理）；
- 相对非 md 链接（`./pic.png` 当链接用）也归 dead——与图片分流（走 img 通道）语义一致。