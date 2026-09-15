# vendor 离线资源清单

| 文件 | 库 · 精确版本 | 许可证 | 全局 | 用途 |
|---|---|---|---|---|
| marked.min.js | marked 4.3.0 (jsdelivr/npm) | MIT | `window.marked` | Markdown → HTML(上游 linux-command 文档渲染) |
| purify.min.js | DOMPurify 3.4.15 (jsdelivr/npm) | Apache-2.0 / MPL-2.0 | `window.DOMPurify` | md 输出白名单消毒(614 篇社区文档不可逐篇审计) |
| highlight.min.js | highlight.js 11.12.0 cdn-assets common (jsdelivr/npm) | BSD-3-Clause | `window.hljs` | 代码块语法高亮(常用语言集,无语言标注按 bash) |

均为 UMD 经典脚本,file:// 直接加载;来源 URL 记录于构建记录,升级需同步改 doc.js 兼容点(marked 4.x 的 headerIds/mangle 选项)。