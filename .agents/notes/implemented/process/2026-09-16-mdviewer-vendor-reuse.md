# Agent Note: Markdown 查看器 vendor 复用与高亮策略
Status: implemented
Class: process

## 背景
markdown-viewer 需要离线渲染管线（页面禁网，不能 CDN）。仓库 linux-command 已 vendor 了一套已知良好的 marked/DOMPurify/highlight 三件套，是否复用、以及复用后语法高亮怎么启用，需要定案。

## 决策
**逐字节复制 linux-command/0.1.0/assets/vendor 同版三件套**（marked 4.3.0 / DOMPurify 3.4.15 / hljs 11.12.0 common，均 UMD file:// 直载），`assets/vendor/` 子目录沿用 owner 特批先例（linux-command/pdf-toolkit 同例），VENDORS.md 同批带上并注明来源。

高亮策略与 linux-command 两处刻意不同：
1. **保留 hljs**（common 集 ~130KB，file:// 零网络成本），cap 30 块——第 31+ 块只上样式不高亮，渲染一致性策略与先例一致；
2. **无语言标注 → 不高亮、不硬套 bash**。linux-command 硬套 bash 是因其内容全是命令文档；通用查看器把配置片段/SQL/日志硬套 bash 会高亮出一堆噪音，套错语言比不高亮更难看。

## 放弃方案
- npm/CDN 重新下载最新版（最强理由：版本最新）。仍然不用：仓库内一份已知制品最稳，且 marked 5.x 移除 `headerIds/mangle` 选项是已知破坏点，跨大版本升级必改兼容点。
- 自研轻量高亮（最强理由：省 130KB）。仍然不用：自研 tokenizer 的语言覆盖和维护成本远超 130KB 的体积收益（code-calc engine.js 有自研先例，但那是单语言编辑器场景）。

## 代价与后果
- vendor 升级需同步改 engine.js 兼容点（marked 4.x headerIds/mangle）+ 复查 DOMPurify 默认 URI 白名单（VENDORS.md 已记）；
- hljs 体积进了发布物——AGENTS.md 发布物完整性核对流程（整目录 add + ls-files 条数核对）对 vendor 是重灾区，已按流程执行。