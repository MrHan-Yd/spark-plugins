# Agent Note: Markdown 查看器 DOMPurify 档位放宽（img/input + checkbox 收口）
Status: implemented
Class: feature

## 背景
linux-command 的消毒档位把 `img` 和 `input` 整个 FORBID——因为它的 614 篇社区文档是受控内容，不需要图片/任务列表。markdown-viewer 看的是**任意来源 md**：图片是一等公民，GFM 任务列表（`- [x]`）是 GitHub 生态的基本语法。两个档位直接复用会导致图片和任务列表全被剥掉。

## 决策
相对 linux-command 档位**只放宽两处**，其余不动：

1. `img` 移出 FORBID_TAGS——渲染 `data:image` 内联图与（目录通道）相对图片；
2. `input` 用 `ADD_TAGS: ['input']` + `ADD_ATTR: ['type','checked','disabled']` 放进白名单，但在自有后处理里收口：**非 `type=checkbox` 的 input 一律删节点；checkbox 强制 `disabled`、删除 `name`**（只读任务列表，不可交互）。消毒产物直接 `article.innerHTML`，收口发生在消毒后的自有 DOM 上，无逃逸口。

svg / math 维持 FORBID（同时封死 mermaid/内联公式的渲染产物）。`style`/`srcset`/`formaction` 等危险属性维持 FORBID。危险 URI（javascript:/data:/vbscript:）依赖 DOMPurify 默认 ALLOWED_URI_REGEXP，未覆写——升级 vendor 必复查该默认白名单仍不含这三种 scheme。

## 放弃方案
- 维持全禁 img/input（最强理由：零新增攻击面）。仍然不用：任意 md 查看器剥掉图片和任务列表，GitHub 生态文档的阅读体验残缺，插件失去存在价值。
- unicode ☐/☑ 预替换任务列表（最强理由：不用碰 input 白名单）。仍然不用：破坏可复制文本语义，且嵌套列表/链接里的 checkbox 处理反而复杂。

## 代价与后果
- 白名单放宽面 = `img` + `input[type=checkbox]` 两处，是本插件相对先例的**唯一**差异；恶意 md 冒烟样例须覆盖 `<script>`、`onerror=`、`javascript:`、`<iframe>`、file:// 链接、伪图片路径；
- 若未来 DOMPurify 升级改变默认 URI 白名单，img data: URI 渲染行为需复查。