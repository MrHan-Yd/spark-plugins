# Agent Note: pdf-editor 新插件立项设计——覆盖式编辑路线 + 青碧视觉拍板

Status: rejected
Class: architecture

> **否决记录（2026-09-17 当日，owner 拍板）**：插件完整施工（4 commit）并真机三轮修复后，owner 得知「类 Word 直接改字」受 mupdf AGPL 许可与开源库能力边界双重封印、无法在免授权前提下实现，判断「白盒预填式编辑」不满足核心诉求，**整个插件移除**（pdf-editor/ 目录与 registry 条目已删，commit 92bbb73..7a9adc8 保留于历史，未来若购买 mupdf 商业授权可整体复活）。本笔记转 rejected 防重犯：**立项前必须先验证「owner 的核心体验诉求在当前技术/许可约束下可达」**——本插件架构与施工质量没有问题，问题在于产品核心诉求超出了约束可达的范围。施工期技术沉淀（坐标局部语义、双实例 copyPages、check-undef 静态扫描、blur 提交等）见 bug-fix 笔记两篇（保留 implemented，教训通用）。

## 背景

第十五个自建插件「PDF 编辑器」（com.spark.pdf-editor，webview）立项，owner 诉求「类 Word 编辑感」。仓库已有 pdf-toolkit（整文件级工具箱），新插件定位逐页逐元素编辑器，二者互补零代码依赖。本轮为设计拍板阶段：system-architect 出架构、ui-designer 出 UI，方案全文沉淀于 docs/插件开发/PDF编辑器-架构方案.md 与 PDF编辑器-UI设计蓝图.md。动手前 recall 查 pdf-toolkit/0.1.0 零历史、全库被拦记录均为 trace sandbox fixture，无历史包袱。

## 决策

1. **技术路线 = 覆盖式编辑（A）**：pdf.js 渲染 + DOM 覆盖层 + pdf-lib 写回；「类 Word」交付为白盒遮盖改字、文本框内实时换行回流、完整快捷键体系。原文不可原位改流，此 UX 契约须在产品文案如实言明。
2. **坐标系唯一权威 = 未旋转 PDF 用户空间（pt，Y 向上，CropBox 视图基准）**，换算收敛 geometry.js 纯函数；导出时统一加 CropBox origin 偏移。
3. **保存通道 = FSA showSaveFilePicker 主 + 下载兜底，不声明 fs.read/write**：宿主 spark.fs 为文本语义 + 10MB 上限，二进制 PDF 经它必损坏（xref lossy），比缺功能恶劣；regex 通道做成「路径引导 + showOpenFilePicker 确认」而非直开。
4. **中文字体 = vendor 预子集思源黑体 SC TTF（GB2312，~2.5MB）+ fontkit subset:true**；缺字该行栅格化降级。必须 TTF（glyf）禁 CFF，规避 fontkit 子集化缺陷族。
5. **行烘焙**：文本框失焦时 Range API 烘焙行文本+基线 pt 进模型，导出端零排版逻辑——「编辑所见≠导出换行」整类 bug 结构性消灭。
6. **UI 主色 = 青碧 Cyan（亮 #0E7490 / 暗 #22D3EE）**：全仓 14 插件色相扫描后唯一空位，避开 pdf-toolkit 玫红；布局为单行 48px「模式 Tab + 工具组」顶栏替代 Word 三行 ribbon，五区（顶栏/缩略图/画布/属性面板/状态栏）+ 三档响应式（1280/中档/窄 720）。
7. **加固协同**：页面加固段一票优先绝不放宽，编辑快捷键绕行（redo=Ctrl+Y/Ctrl+Shift+Z，永绑 F5/Ctrl+P 之外），豁免选择器扩 `[contenteditable]`，键表集中分发禁散落 keydown。
8. 两专家口径统一：浮动工具条 P0 服务覆盖元素/白盒预填（文本层 P0 不启用，防 CJK 文本层坐标偏移，架构 R2），原文选区浮动条随 P1 文本层开启。

## 放弃方案

- **内容流真编辑（B）**：最强理由是用户体验真原位改字；但 pdf-lib 无文本抽取/写 API、mupdf.js wasm AGPL 传染对闭源签名插件一票否决、HummusJS 无浏览器构建、中文子集 CID 字体原位重排 = 自写排版引擎——四条死刑，任一条都足以否决。
- **整页抽取重排版（C）独立路线**：最强理由是 Word 感最强；但丢原版式与「编辑器」定位冲突；其内核（框内回流）被 A 的文本框模型天然覆盖，收敛不独立建引擎。
- **fs.read 路径直开**（md-viewer 先例优雅）：最强理由是入口体验一致；但文本语义读二进制是静默数据损坏 + 10MB 上限拦掉大多数真实 PDF，静默损坏比缺功能恶劣得多。
- **全程 CSS transform 缩放**（省渲染）：canvas k>1 永久模糊、命中要过逆矩阵、层对齐漂移三宗罪；拍板两段式。
- **全栅格化导出**（toolkit 水印先例）：省字体工程但输出不可选中/可检索，编辑器底线不允许。

## 代价与后果

- 原文不可原位改流：用户首次使用需状态栏提示一次；白盒+预填交互糖补偿。
- vendor 增至 ~12MB（179 cmaps + 字体 TTF 是发布物核对重灾区）；P0 无独立 Bold 字重（faux-bold 不进导出）。
- 草稿与导出是双副本最终一致，靠 dirty + onClose 兜底，非事务。
- 施工时按架构 §13 落 ADR-1/2/4/5 四篇 implemented 笔记并转正本篇；里程碑 M1→M6，M4 导出冒烟矩阵全绿是保存按钮接线门禁。

## 施工结果（2026-09-17 同日完成转正）

- M1-M6 全部落地：js/ 十三模块 + 三件套 + vendor，127 断言全绿（verify-m1 69 + export-smoke 门禁 26 + dom-smoke 32）。
- M4 门禁实测抓出 4 处真缺陷并修复：存储坐标语义统一为「CropBox 局部」（pdf.js 真实变换对拍证实）；export 同实例自 copyPages 翻倍页数（改双实例重建页序）；缺字探测误用 pdf-lib PDFFont（改 fontkit Font）；burnOverlay 异步 embed 未 await 时序丢失。
- 坐标五象限对拍全绿（0/90/180/270 × CropBox≠MediaBox，pdf.js 真实变换 vs geometry 四象限公式 ≤1pt）——ADR-2 公式与 pdf.js 语义一致性实证。
- 字体落地：Windows 预装 NotoSansSC-VF.ttf（17MB）经 harfbuzz subset-font 固化 wght=400 + GB2312 全表预子集 → 2.43MB 静态 TTF（dev-only 生成脚本 .zcode/pdf-editor/gen-font.mjs）；name 表残留 Thin 命名无碍嵌入（harfbuzz 不重写 name ID6，字形已固化）。3000 汉字压力导出真文本可检索全过。
- 签名与 registry：spark-sign 签名 208 文件清单 + verify official + blob 对拍 208 项全对齐 + registry 第 16 条目准入通过（check-registry 仅台账已知 password-manager/trace-board 旧错，非本次引入）。
- 相对架构方案的施工细化：测试脚本统放 .zcode/pdf-editor/（dev-only）；export 用双实例 copyPages（同实例自复制会翻倍页数）；window 字段 snake_case（markdown-viewer 先例）。

## 关联

- 方案全文：docs/插件开发/PDF编辑器-架构方案.md、docs/插件开发/PDF编辑器-UI设计蓝图.md
- 前例：[[mdviewer-entry-and-fs-read]]（入口矩阵/fs 语义先读）、toolkit engine.js stampAnchor 与 saveBlob 双通道
- 坐标细则：[[2026-09-17-pdf-editor-coord-system]]
- 留痕声明：本轮未过宿主（SPARK_TRACE_SESSION 为空，直开客户端会话），无协议留痕；代码内决策注释已挂 @see 文档锚点（check-trace-anchors 5/5 过）。