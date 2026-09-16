# Agent Note: Markdown 查看器 GitHub 兼容 slug 与 TOC/阅读位置锚
Status: implemented
Class: feature

## 背景
vendor marked 4.3.0 以 `headerIds: false` 调用（linux-command 先例），渲染出的标题没有 id——md 作者手写的 `[跳转](#section-title)` 锚点全断，阅读位置持久化也没有稳定锚。

## 决策
`engine.js makeSlugger()` 自建 **GitHub 兼容 slug**：小写、去标点（保留 Unicode 字母数字）、空白→`-`、重名追加 `-1/-2`。一份实现吃三份收益：

1. md 作者手写的 `#section-title` 锚点天然恢复工作（GitHub 生态文档普遍用此约定）；
2. TOC 数据（h1-h6 全量、层级缩进渲染）以 slug 为 id，`toc-item` 点击滚动；
3. 阅读位置持久化以「当前视口顶部所在的标题 slug」为主锚 + `ratio` 兜底——标题结构不变则精确恢复，变了也不至于回到顶部（pos LRU cap 50）。

## 放弃方案
- linux-command 式序号 id（`md-h-0/1/2`，最强理由：实现最简单、永不冲突）。仍然不用：序号随文档结构漂移，md 手写锚点对不上号，阅读位置跨版本失效——「锚点」名存实亡。
- marked headerIds 开着不动（最强理由：零代码）。仍然不用：marked 4 的 headerIds 生成的是旧 GitHub 风格（去中文、mangle 编码中文），与现 GitHub 约定不一致，且 5.x 已移除该选项，升级必断。

## 代价与后果
- slugger 与 GitHub 实现在极端字符（emoji-only 标题、全标点标题）上可能有 ±1 字符差异——锚点 miss 时静默不跳，无副作用；
- 同名标题依赖 `-1/-2` 序号，重排文档仍会漂移（ratio 兜底覆盖此场景）。