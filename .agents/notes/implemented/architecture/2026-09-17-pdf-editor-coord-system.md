# Agent Note: pdf-editor 坐标系唯一权威拍板（ADR-2 落地）

Status: implemented
Class: architecture

## 背景

pdf-editor（com.spark.pdf-editor）M1 施工：geometry.js 是坐标换算唯一权威，坐标语义错一处则编辑态与导出态全面错位，是全插件最高危接缝。方案全文见 @see 架构文档 §5.1；本篇是落地定稿与施工期细化记录。M1 测试 68/68 绿（.zcode/pdf-editor/verify-m1.mjs）。

## 决策

1. **存储坐标系 = 未旋转 CropBox 局部空间**：pt、原点 = CropBox 左下、Y 向上、矩形 {x,y,w,h} 的 (x,y) 为左下角。即 lx ∈ [0, cropW]、ly ∈ [0, cropH]。
2. **视图坐标是临时值**：pdf.js viewport CSS px（Y 向下、含 /Rotate+rotateDelta、含 scale）；交互事件落库前必须经 `pointCssToPage`，渲染出口必须经 `pointPageToCss`；**除 geometry.js 外任何模块禁止乘除 scale 的坐标算术**（code review 一票项）。
3. **换算公式四象限显式**（rot90 = 顺时针，屏幕宽高对易），矩形用四角 min/max 包围盒法——任意象限统一，无角落特判；往返恒等在 4 象限 × crop 偏移 × 非整 scale 下测试（200 随机点/象限）。
4. **导出偏移单点收口**：`toPdfLibPoint/Rect` 加回 cropX/cropY 得 pdf-lib 绘制空间绝对坐标；页旋转走 `page.setRotation`（页面属性，内容流坐标不变），导出端零旋转矩阵。
5. **rot 90/270 的 pdf.js 语义与上式的一致性，M4 冒烟矩阵用真 pdf.js `viewport.convertToPdfPoint` 对拍**（含 CropBox≠MediaBox 夹具）——geometry.js 头注释已写明该对拍义务，公式如有出入只改 geometry.js 一处。

## 放弃方案

- **存 pdf.js viewport 绝对 pt（含 CropBox 原点）**：与 viewport 对齐直接，但页边界/吸附/裁剪都变成 [cropX, cropX+cw] 区间运算，且导出换算与「页局部尺寸」直觉错位；局部空间下边界恒为 [0, cw]×[0, ch]，公式与测试都最简。99% 文档 CropBox=MediaBox 两者等价，不为它们多一层绝对坐标。
- **存 CSS px**（以某 zoom 为基准）：换 zoom 全量重算 + 浮点误差累积 + 旋转页语义混乱，直接违反缩放不变性。
- **依赖 pdf.js viewport 对象方法做换算**：Node 沙箱无 pdf.js，纯函数层不可测（测试策略地基，架构 §13 分层硬边界）；pdf.js 对象只在 render.js 提取参数（crop/rotation/scale）喂 `makePageCtx`。
- **rect 旋转角落公式特判**（90/270 分支宽高对易硬编码）：四角包围盒法一行通吃四象限，特判是纯增 bug 面。

## 代价与后果

- geometry.js 与 pdf.js 真实变换的一致性押注在 M4 冒烟对拍（若 90/270 语义反了，只改 geometry.js 公式一处）——这是「换算收敛单文件」换来的修复半径。
- 命令/序列化全链路的坐标语义已随 geometry.js 注释定死，schema v1 文档以本笔记 + geometry.js 头为准。
- 施工相对架构方案的三处细化（非路线推翻）：①存储空间明确为「CropBox 局部」（架构文字「未旋转用户空间 + 导出加 (cx,cy)」的组合即此，说死防歧义）；②Page schema 不设 deleted 字段——删除 = 物理移除 + history pageList 快照撤销；③纯 Node 测试放 `.zcode/pdf-editor/`（dev-only，不进发布物与签名清单），非方案原写的插件目录 tests/。
- 留痕：本轮未过宿主（SPARK_TRACE_SESSION 空，直开客户端会话），无 @trace；代码内决策注释已挂 @see 文档锚点（check-trace-anchors 校验通过）。

## 关联

- 立项总拍板：[2026-09-17-pdf-editor-design](../2026-09-17-pdf-editor-design.md)（施工完成后转正）
- 代码：pdf-editor/0.1.0/js/geometry.js（头注释含完整四象限推导）
- 测试：.zcode/pdf-editor/verify-m1.mjs（68 断言全绿，2026-09-17）