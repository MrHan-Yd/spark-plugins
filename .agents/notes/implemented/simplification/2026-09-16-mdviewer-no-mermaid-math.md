# Agent Note: Markdown 查看器一期砍掉 mermaid 与数学公式
Status: implemented
Class: simplification

## 背景
设计评审时 mermaid 图表与 KaTeX 数学公式被提上候选。两者都是 md 渲染器的常见二期期待，需要明确一期做不做。

## 决策
**一期都不做**。```mermaid 围栏降级为带 `mermaid` 语言标签的普通代码块（语言标签照常显示）；`$..$`/`$$..$$` 原文照常以正文/行内 code 样式显示，不吞内容。

理由三连：
1. vendor 成本：mermaid ~1MB + KaTeX ~280KB，仓库发布物体积翻倍，market zipball 变重；
2. 渲染产物是 svg / MathML——DOMPurify 档位里 `svg|math` 维持 FORBID，支持它们就要开消毒逃逸口或做二次消毒管线，安全面陡增；
3. 通用 md 文档（README/笔记/规范）中两者出现率低，收益不抵成本。

## 放弃方案
- 一期带上 mermaid（最强理由：图表类 md（架构文档）体验立涨一个档次）。仍然不用：1MB vendor + svg 消毒逃逸口 + 低频，三项叠加不值；二期若做，`mermaid.parse` 产物走独立白名单二次消毒，成本单独评估。
- KaTeX（最强理由：学术文档刚需）。仍然不用：`$..$` 语义有歧义（两个价格符号就是误伤），误渲染比不渲染更糟。

## 代价与后果
- mermaid 图表/公式在查看器里以源码形式可读（不吞内容，符合「查看器保真」底线）；
- 未来支持需同时动：vendor 清单、DOMPurify 档位（svg 解禁）、engine 渲染管线三处，属二期特性级改动。