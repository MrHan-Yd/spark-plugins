# vendor 离线资源清单

| 文件 | 库 · 精确版本 | 许可证 | 全局 | 用途 |
|---|---|---|---|---|
| marked.min.js | marked 4.3.0 (jsdelivr/npm) | MIT | `window.marked` | Markdown → HTML（GFM 表格/任务列表/删除线） |
| purify.min.js | DOMPurify 3.4.15 (jsdelivr/npm) | Apache-2.0 / MPL-2.0 | `window.DOMPurify` | md 输出白名单消毒（任意来源 md 不可逐篇审计） |
| highlight.min.js | highlight.js 11.12.0 cdn-assets common (jsdelivr/npm) | BSD-3-Clause | `window.hljs` | 代码块语法高亮（常用语言集，无语言标注不高亮） |

均为 UMD 经典脚本，file:// 直接加载；来源 URL 记录于构建记录，升级需同步改 engine.js 兼容点（marked 4.x 的 headerIds/mangle 选项）。
制品与 linux-command/0.1.0/assets/vendor 同源同版（2026-09-16 复制）；本插件对 DOMPurify 档位有两处放宽（img/input），见 engine.js 头注与决策笔记。