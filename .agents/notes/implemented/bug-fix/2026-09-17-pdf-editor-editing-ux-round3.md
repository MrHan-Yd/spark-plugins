# Agent Note: pdf-editor 编辑交互链路四缺陷 + 「点击原文白盒预填」补齐

Status: implemented
Class: bug-fix

## 背景

真机第三轮：渲染已通，用户「想编辑 PDF 内容编辑不了」。自查编辑链路发现三处真缺陷 + 一项 P0 功能缺失（点击原文白盒预填，架构功能 4 施工时被裁掉）。三缺陷叠加的净效果：**用户能画框、能打字，但内容永远存不下来**——「编辑不了」的主感受来源。

## 决策

1. **拖拽移动 drag 缺 startX/startY**（interact.js）：move 分支 dx=NaN → transform(NaN) → 提交 NaN 坐标污染模型。补起点记录。
2. **就地编辑无 blur 提交**（interact.js）：contenteditable 打字后点外部/Esc 之外的任何失焦路径都不触发 bake+提交，输入全丢。修：enterTextEdit 挂 once blur → exitTextEdit(true)；onPointerDown 开头统一「点编辑框外交先提交、点框内交给光标」。
3. **syncPage 不保护编辑中元素**（overlay-view.js）：selection 变化等任何 store 广播都会全量重排、重建 contenteditable DOM（光标/输入丢失）。修：editingId 元素跳过重建（编辑结束由提交路径的重排接管）。
4. **补齐「点击原文 → 自动白盒+预填」**（架构 P0 功能 4，前轮施工缺失）：白盒工具**单击**原文（位移<6px）→ getTextContent item 命中测试（原页 viewport(scale=1,/Rotate) 空间，容差 28pt 取最近）→ bbox 两角经 srcCtx 反算局部矩形 → 白盒+预填文本框一个撤销单元（复合命令）→ 选中并直接进入编辑。坐标自洽依赖存储空间的未旋转权威性（rotateDelta 只影响视图换算，不影响局部点与原页几何的对应）；预填位置是建议值（架构 R2），用户可拖正。
5. render.js 暴露 srcCtxOf（scale=1 仅 /Rotate 的原页几何，与 getTextContent item 同基准，与编辑视图 rotateDelta 解耦）。

## 放弃方案

- **pdf.js 文本层选区直接改字**：架构 ADR-1 已否决内容流真编辑；白盒预填是覆盖式路线下「改字」的正确交互形态。
- **编辑提交时机改为每次输入**（input 事件实时提交）：撤销栈会被每个按键污染，且行烘焙需在稳定态执行；失焦一次性提交（架构 §6.4 coalescing）保持不变。

## 代价与后果

- 单击白盒工具在无文字区域（图片/表格线）会提示「未找到文字」，需拖拽——预填是辅助不是承诺（R2），UI 文案已如实引导。
- 回归全绿：127 断言 + check-undef 11 文件。真机复测清单：拖拽移动元素、双击文本框改字并点外部提交、白盒工具单击原文自动遮盖改写、Ctrl+Z 一次撤销整组白盒+文本。
- 留痕：本轮未过宿主（SPARK_TRACE_SESSION 空），无 @trace。

## 关联

- [[2026-09-17-pdf-editor-open-null-map]]、[[2026-09-17-pdf-editor-canvas-blank-and-undef-scanner]]（前两轮）、[[2026-09-17-pdf-editor-design]]