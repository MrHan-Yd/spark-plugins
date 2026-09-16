# Agent Note: Markdown 查看器 Reader 通道抽象与二进制能力位
Status: implemented
Class: architecture

## 背景
markdown-viewer 有三条打开通道：spark.fs 路径直开、File API 手选单文件、File API 手选目录。宿主三个实测事实（trace-board source.js 已验证）：spark.fs 只有 read/write 没有目录列举/stat/watch；fs/net 均为 UTF-8 纯文本通道（二进制必损坏）；`<input type=file>` 单选拿不到兄弟文件。

## 决策
`source.js` 把三通道统一成 Reader 接口：`readText(rel)` / `readBlob(rel)` / `canReadBinary()` / `hasFile(rel)` / `describe()`，渲染层只认接口不认通道。关键能力位 `canReadBinary`：fs 与单文件通道恒 false，目录通道 true——它直接决定 md 里相对路径图片是「objectURL 渲染」还是「占位卡降级」（engine.js 打标 `data-img=pending|remote|blocked`，app.js 落地）。

| 通道 | 文本 | 二进制图片 | 相对 .md 跳转 | 权限 |
|---|---|---|---|---|
| SparkFsReader | ✅ ≤10MB | ❌ | ✅（dir+href 再走 fs.read） | fs.read |
| SingleFileReader | ✅ | ❌ | ❌（toast 降级） | 零 |
| DirReader | ✅ | ✅ objectURL | ✅（表内查找） | 零 |

regex/keyword 通道的路径提取在 source.js 单点收口：候选按可信度排序（成对引号包裹 > 盘符绝对 > UNC > POSIX > 相对 > 最后一个 .md token），逐个试读，第一个读得通的赢；统一去引号/空白，`\`→`/` 归一。

## 放弃方案
不抽象、三通道各写各的渲染降级逻辑——最强理由是省一层接口代码。仍然不用：图片/链接降级矩阵在渲染层三处重复，行为必然分叉（trace-board 已用同款 Reader 抽象踩平此坑）。

## 代价与后果
- 多一层接口约定（~40 行）；换来图片/链接行为三通道一致，新增通道（如未来 spark 出 stat/watch）只加一个 Reader；
- objectURL 换渲染前必须 revokeAll（app.js `revokeUrls()`），否则长会话内存泄漏。