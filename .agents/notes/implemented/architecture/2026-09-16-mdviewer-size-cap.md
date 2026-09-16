# Agent Note: Markdown 查看器 10MB 全通道统一上限（不做分片）
Status: implemented
Class: architecture

## 背景
宿主 `spark.fs.read` 单文件硬限 10MB 文本。File API 通道（手选/拖拽）本没有上限，是否放行超大 md 需要拍板。

## 决策
**全通道统一 10MB**：File API 通道读取前看 `file.size`，超限拒读并提示「文件超过 10MB」。不做 File.slice 分片拼接。

## 放弃方案
分片拼接（最强理由：能读 50MB 大文件）。仍然不用：分片救的是「读取」，瓶颈根本不在读取——在 `marked.parse`（10MB 字符串秒级）+ 单次 innerHTML 的 DOM 规模（数十万节点，WebView2 布局直接卡死）。完整拼出 50MB 文本后照样卡死，还引入双倍内存峰值，是伪解。10MB md ≈ 千万字符 ≈ 数千页 A4，现实中这个量级的「md 文档」是日志/数据导出，不是阅读对象。

## 代价与后果
- 手选/拖入超 10MB 文件得到明确错误态（「文件超过 10 MB」），不卡死不 OOM；
- 上限与宿主 fs.read 对齐，心智一致；未来宿主放宽，本插件单点改 `MAX_BYTES` 即可。