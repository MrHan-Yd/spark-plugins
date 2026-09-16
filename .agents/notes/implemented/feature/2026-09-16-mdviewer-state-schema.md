# Agent Note: Markdown 查看器状态 schema（spark.db 键契约）
Status: implemented
Class: feature

## 背景
查看器的真需求：阅读位置跨会话恢复、最近打开列表、字号/大纲偏好。宿主 `spark.db` 是插件私有 KV 沙箱（默认开放、免授权），`onClose` 回调可做存盘。

## 决策
四个顶层键（app.js `KEY_*`）：

| key | 内容 | 写入时机 |
|---|---|---|
| `recent` | 最近 ≤10 条 `{key,name,path,source,ts}`；仅 fs 通道条目可点击重开 | 打开成功时 unshift 去重 |
| `pos` | `{[文件key]: {slug, ratio, ts}}`，LRU cap 50 | 滚动 debounce 500ms + onClose flush |
| `font_size` | 12–20 整数（默认 15） | 变更 debounce 300ms |
| `toc_open` / `toc_width` | 大纲显隐 / 拖宽后的宽度（180–320） | 变更时 |

key 归一：fs 通道 = `fs:<归一小写路径>`；file 通道 = `file:<name>:<size>`（句柄不持久，仅阅读位置当次会话有效；最近列表里 file/dir 条目灰显并提示「文件句柄不持久，请重新选择」）。

恢复策略：优先 slug（标题没变 → 精确 offsetTop）；slug miss → `ratio * maxScroll` 兜底；都没有 → 顶部。onClose 里 fire-and-forget 调 `savePos()`（async 写入不 await，小 JSON 可接受）。

## 放弃方案
- localStorage（最强理由：零 await、同步写、onClose 里最可靠）。仍然不用：WebView2 file:// 下 localStorage 行为依赖宿主配置，而 spark.db 是宿主担保落盘的插件私有沙箱（`plugin-data/<id>/db`），且默认开放免授权。
- 全内存不持久（最强理由：零代码）。仍然不用：阅读位置跨会话恢复是查看器核心卖点，砍掉等于砍掉回访体验。

## 代价与后果
- 持久化全走 async，boot 时读 `recent/font_size/toc_open` 有一个 tick 的默认值闪烁（肉眼不可见）；
- file/dir 通道句柄不持久是宿主事实，最近列表灰显条目是「如实呈现」而非功能缺失。