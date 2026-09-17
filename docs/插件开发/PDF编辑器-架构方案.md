# PDF 编辑器（com.spark.pdf-editor）架构方案 v1.0

> system-architect 交付（2026-09-17）· 施工蓝本
> 决策笔记：[2026-09-17-pdf-editor-design](../../.agents/notes/proposed/architecture/2026-09-17-pdf-editor-design.md)

## 0. 定位与边界：与 pdf-toolkit 的互补矩阵

| 维度 | pdf-toolkit | pdf-editor（本插件） |
|---|---|---|
| 操作粒度 | 整文件级（压/合/拆/转） | 逐页逐元素（改字/贴图/批注/页面级编排） |
| 交互形态 | 表单→批处理→出结果 | 所见即所得画布，长时间驻留编辑 |
| 状态模型 | 无状态工具页 | 有状态编辑会话（草稿/撤销/脏标记） |
| 产出 | 新文件批量导出 | 单文件覆写/另存 + 会话草稿 |

**功能红线**：不做合并/拆分批量工具（toolkit 已有），不做格式转换。页面级操作只保留「编辑会话内」的旋转/删除/重排/复制/插页——这是编辑器的排版需要，不是工具箱的批处理。两侧共享的只有 vendor 同源（pdf.js/pdf-lib 同版本锁定），**零代码依赖**。

## 1. 架构拓扑与质量属性

### 1.1 系统拓扑

```
┌─ Spark 宿主 ────────────────────────────────────────────────┐
│  spark.db(草稿KV沙箱)   spark.notify   spark.onClose        │
│  WebView2 (file:// 虚拟主机加载)   FSA showSaveFilePicker   │
└───────────▲───────────────────────────────▲────────────────┘
            │ JSON 草稿                       │ 二进制写出流
┌───────────┴───────────────────────────────┴────────────────┐
│ pdf-editor 页面（纯离线，零网络）                            │
│                                                            │
│  外壳层 shell.js ── 入口通道/打开/保存流程/加固段/草稿恢复     │
│    │                                                       │
│  状态层 store.js ── 集中 store + topic 订阅（唯一写口）       │
│    │                        │                              │
│  视图层 render.js      overlay-view.js + interact.js       │
│   (pdf.js canvas 虚拟化)   (DOM 覆盖层/手柄/指针/键盘)        │
│    │                        │                              │
│  领域层 model.js / geometry.js / history.js / pages.js      │
│   (覆盖物模型/坐标换算/命令栈/页面级操作)  ← 全部 Node 可测   │
│    │                                                       │
│  持久层 export.js ── pdf-lib+fontkit 合成 → Blob → FSA      │
└────────────────────────────────────────────────────────────┘
```

数据流向单向：**交互 → geometry 换算 → store 变异（经 history 命令）→ topic 广播 → 视图重排**。视图永不回写 store。

### 1.2 非功能设计

- **并发模型**：主线程只做 DOM；PDF 解析/渲染全在 pdf.js worker；pdf-lib 合成在主线程同步执行（导出为低频操作，文档 ≤200MB 内可接受，超限走分块提示）。渲染队列并发 ≤2，按「可视中心向外」优先。
- **一致性模型**：草稿（spark.db）与导出文件是**两个独立的最终一致副本**——草稿是编辑态权威，导出文件由用户显式触发生成；二者不做事务，靠 dirty 标记 + onClose 兜底对齐。
- **高可用**：崩溃丢上限 = 自动保存间隔（2s debounce）内的操作；草稿写入失败（db 超预算）降级为状态条警示，不阻断编辑。
- **内存预算**：常驻 = 原始字节 1 份 + pdf.js 文档对象 + 可视页 canvas（≤3 页）+ 覆盖物 JSON（轻量）。pdf-lib 文档对象**仅导出瞬间实例化，用完即弃**。

### 1.3 关键质量属性目标

| 属性 | 目标 | 验证手段 |
|---|---|---|
| 坐标正确性 | 覆盖物在 0/90/180/270 旋转页、CropBox≠MediaBox 页上导出后视觉位置与编辑态一致 | Node 导出冒烟矩阵（§11） |
| 500 页大文档 | 打开 ≤3s 出首页，滚动不爆内存 | 虚拟化 + cleanup，CDP 冒烟 |
| 中文编辑 | 全量 GB2312 字可导出且可被其它阅读器选取复制 | 字体子集压力冒烟 |
| 崩溃恢复 | 重开插件 2s 内恢复草稿 | dom-smoke |

## 2. 技术路线拍板（核心难题）

### 路线 A：覆盖式编辑（pdf.js 渲染 + DOM 覆盖层 + pdf-lib 写回）—— **选定为主**

- **可行性**：pdf.js 提供逐页 viewport（含 /Rotate、CropBox 归一化后的 CSS 变换矩阵），pdf-lib 提供在用户空间画文本/图/形能力。二者坐标可建立严格换算（§5.2）。Sejda 等在线编辑器同路线，工程路径成熟。
- **Word 感的实现方式（UX 契约，必须明说）**：Word 感 ≠ 原位重排。本路线交付的 Word 感 = ①画布即打即排（文本框内实时换行）②点击原文即出白盒预填改写 ③完整编辑快捷键体系 ④段落级操作手感（对齐/吸附/多选）。**原文永远不可原位改流**——改字 = 白盒遮盖 + 等效新文本叠加，这是行业惯例，需在首次使用时向用户言明（状态栏提示一次）。

### 路线 B：内容流真编辑（原位改字重排）—— **否决，结论明确不可行**

逐库给死刑理由：

1. **pdf-lib**：无文本抽取、无 content stream 写 API（只有低层 PDFDict 手术）。改一个字需要自己解析 Tf/Tj/TJ 算子、重建宽度表、处理子集字体的 CID↔GID 映射——等于自写半个排版引擎，工程量与维护风险不可接受。
2. **mupdf.js (wasm)**：能力最接近真编辑（结构化抽取+内容改写），但 **AGPL-3.0/商业双授权**——本仓库是官方签名插件、闭源分发场景，AGPL 传染 + wasm 体积（数十 MB）双重否决，**license 一票否决，不再评估技术面**。
3. **HummusJS**：Node 原生 C++ 绑定，WebView 无浏览器构建，直接出局。
4. **中文子集字体重排**（独立于库）：原位改字要求新字形度量与原字体匹配——原 PDF 字体是子集嵌入的 CID 字体，**没有原始字形可扩展**，必须引入新字体并接受度量不齐（标点挤压、行宽溢出全要自己重排）。这本身就是排版引擎级工作量。

**结论：B 在本仓库约束（离线/无构建链/闭源分发/单插件人力）下明确不可行，不留"部分 B"的伪折中**。唯一的 B 残留是「点击原文→自动建白盒+预填文本」这个交互糖，属于 A 的辅助定位，不是 B。

### 路线 C：抽取重排版 —— **降维收敛，不作为独立路线**

「抽取→可编辑流式文档→重新生成」会丢原版式，与「编辑器」定位冲突。但其 Word 感内核——**框内自动换行的流式文本**——恰好就是 A 的文本框模型天然具备的能力。**拍板：C 不建独立引擎，收敛为 A 文本框的多行回流能力**（§5.1 text 类型）。从零写页（空白页 + 连续文本框）由 A 直接覆盖；"整页抽取转可回流文档"留 P2 且明确标注为实验性。

**最终路线：A（全功能域）+ 页面级结构操作（pdf-lib copyPages/setRotation，toolkit merge.js 已验证该 API 面）+ 文本框多行回流（吸收 C 的 Word 感）。**

## 3. 功能分级与依赖顺序

### P0（首版必做，编辑闭环的最小完整集）

| # | 功能 | 依赖 |
|---|---|---|
| 1 | 打开三通道（§9）+ 加密 PDF 明确报错 | shell |
| 2 | 连续滚动虚拟化渲染 + 两段式缩放 | render |
| 3 | 文本框：加/编辑/删，中文、字号/颜色/对齐/加粗、自动换行 | model+interact |
| 4 | 白盒覆盖 + 「点击原文→白盒预填」辅助 | overlay-view |
| 5 | 图片插入（文件选择/粘贴） | model |
| 6 | 高亮矩形 | shape-lite |
| 7 | 选中/移动/八向缩放/Delete/Esc/边缘吸附 | interact |
| 8 | 撤销重做：Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z | history |
| 9 | 页面级：旋转±90°、删除、重排、复制页 | pages |
| 10 | 保存（FSA 另存/覆写确认 + 下载兜底）+ dirty + onClose | export+shell |
| 11 | 草稿自动保存（spark.db）+ 重开恢复 | shell |
| 12 | 页面加固段 + 编辑快捷键协同（§6.5） | interact |

### P1

形状（线条/箭头/椭圆）、自由绘制（ink 笔迹）、签名（画板/图片/粘贴图片）、AcroForm 表单填写（pdf.js 读字段值 + pdf-lib form 写回，含 updateFieldAppearances 中文字体）、富文本属性面板（行距/元素旋转 90 步进）、多选/成组、z 序面板、网格吸附、从其他 PDF 插页、缩略图栏拖拽重排、文本复制层（pdf.js TextLayer）、明暗主题。

### P2（实验性/依赖宿主演进）

覆盖物导出为**标准 PDF 注释对象**（/Annots，保留可撤销批注语义——当前覆盖式导出是"烧录"）；整页抽取转回流文档（C 残念，明确标实验）；宿主若开放二进制 fs.read/write（fs 语义 v2），接通真正的路径直开与原路径覆写（§9.2 已预留接口位）。

### 工程依赖顺序（里程碑）

```
M1 geometry.js + model.js + store.js   —— 纯函数层，Node 测试先行
M2 render.js 虚拟化渲染                  —— 无编辑，只读查看器闭环
M3 overlay-view + interact + history     —— 编辑交互闭环（无导出）
M4 export.js 导出管线                    —— Node 导出冒烟矩阵全绿后接 UI
M5 shell 保存/草稿/加固/入口             —— 产品闭环
M6 pages.js 页面级操作                    —— pdf-lib 结构面，最后接
```

**铁律：M4 的坐标冒烟矩阵不全绿，不得开始 M5 的保存按钮接线**（坐标错误在导出后才发现是最贵的事故）。

## 4. 模块分层与文件结构

```
pdf-editor/0.1.0/
  plugin.json
  index.html            ~220 行  结构：工具栏/页画布区/属性面板/状态栏/空态
  style.css             ~600 行  布局/主题/工具栏/面板
  overlay.css           ~320 行  覆盖物/选择手柄/参考线/签名画板
  js/
    geometry.js         ~320 行  坐标换算纯函数（唯一换算权威，Node 可测）
    model.js            ~380 行  Overlay/Page 工厂、校验、草稿序列化 schema v1
    store.js            ~280 行  集中状态 + topic 订阅 + 唯一写口 apply()
    history.js          ~180 行  命令模式 undo/redo 栈
    render.js           ~560 行  pdf.js 打开/虚拟化/渲染队列/两段式缩放
    overlay-view.js     ~600 行  覆盖物 DOM 同步/手柄/参考线渲染
    interact.js         ~650 行  指针交互(选/拖/缩放/绘制) + 快捷键表 + 加固协同
    pages.js            ~350 行  页面级操作 + 缩略图栏
    export.js           ~500 行  pdf-lib 合成管线（页面结构 + 覆盖物烧录 + 行烘焙）
    shell.js            ~550 行  外壳：入口通道/打开/保存流程/草稿恢复/页面加固段
  assets/vendor/        （§10 清单）
  tests/                geometry.test.mjs / model.test.mjs / export-smoke.mjs
  ../../.zcode/pdf-editor/dom-smoke.mjs（仓库惯例位置）
```

index.html 加载序：`pdf.min.js → pdf-lib.min.js → fontkit.umd.min.js → geometry → model → history → store → render → overlay-view → interact → pages → export → shell`。每文件 IIFE 全局导出（仓库惯例，无构建链）；**geometry/model/history/store 顶层不触 DOM**，保证 Node 沙箱可载（toolkit engine.js 先例）。

各层职责一句话：

- **外壳层（shell.js）**：文档生命周期（打开三通道→激活→关闭）、保存流程编排、草稿恢复、加固段。不知道坐标换算。
- **文档模型层（model/store/pages）**：覆盖物与页的唯一权威数据；store 是唯一写口。
- **渲染层（render.js）**：三明治结构——`div.page-frame[px 尺寸=viewport] > canvas(pdf.js) + div.overlay-layer(绝对定位覆盖物 DOM)`。P0 不建 pdf.js 文本层（CJK 坐标偏移风险，§8-R2），P1 再开且仅用于复制文本。
- **编辑引擎层（interact/overlay-view）**：所有指针/键盘事件 → geometry 换算 → store；视图只订阅。
- **持久层（export.js + shell 保存流）**：草稿走 spark.db（JSON），成文件走 pdf-lib→Blob→FSA。

## 5. 覆盖物对象模型（编辑元素数据结构）

### 5.1 坐标系拍板（最易错处，先拍）

**唯一权威存储坐标系：未旋转 PDF 用户空间（unit = pt，原点左下，Y 向上，以该页 CropBox 视图空间为基准——见 CropBox 条款）。**

- CSS 像素（viewport 派生，含页面 /Rotate、scale、Y 向下）只是**视图层临时值**，交互事件进来立刻经 `geometry.cssToPage()` 落库为 pt，渲染时经 `pageToCss()` 出去。**除 geometry.js 外任何模块禁止出现乘除 scale 的坐标算术。**
- 缩放不变性：存 pt，换 zoom 后覆盖物零重算语义（只需重排 DOM left/top）。
- 旋转不变性：存**未旋转**用户空间 → 用户对页面做 90° 旋转操作时，覆盖物随内容一起转（正确行为）；编辑视图里的 px 由 pdf.js viewport（含旋转）统一换算，所见即所得。
- **CropBox 条款（隐藏地雷，必须写死）**：pdf.js viewport 以 CropBox（view）为基准，pdf-lib 默认在 MediaBox 空间绘制。geometry.js 初始化每页时读取 CropBox origin (cx,cy)，**统一换算约定为：存储坐标以 CropBox 视图空间为基准，导出时统一加 (cx, cy) 偏移**。CropBox=MediaBox 的 99% 文档偏移为零，但冒烟矩阵必须含 CropBox≠MediaBox 用例（§11）。

geometry.js 对外接口（示意）：

```
makePageCtx(viewport, cropboxOrigin)     // 每页构建一次换算上下文
cssToPage(px, py, ctx) -> {x, y}         // px → unrotated user space(pt, Y-up)
pageToCss(x, y, ctx)    -> {px, py}      // 反向
rectPageToCss(r, ctx) / rectCssToPage(r, ctx)  // 矩形（含 Y 翻转、宽高对易）
```

### 5.2 对象模型 schema（草稿 JSON schema v1）

```
Overlay {
  id: "ov_<seq>",
  type: "text" | "image" | "shape" | "ink" | "signature",
  pageId: "pg_<seq>",           // 页用 uuid 引用，不用 index（页面可重排）
  x, y, w, h,                   // pt，未旋转用户空间，左下原点
  rotate: 0,                     // 元素级旋转（P0 恒 0，字段预留 P1）
  z: <int>,                     // 页内绘制序，大者在上；显式存储
  opacity: 1.0, locked: false,
  anchor: null | { sample: "原文片段", at: {x,y} },   // 「点原文建白盒」溯源提示
  text: {                        // type=text 必填
    value: "…",
    fontSize: 12, lineHeight: 1.4, color: "#111111",
    align: "left"|"center"|"right", bold: false, fontKey: "notosc",
    lines: [ { text: "第一行", baseY: <pt> }, … ]     // 行烘焙，见 §7.2
  },
  image:   { assetId: "as_<hash>", naturalW, naturalH },
  shape:   { kind: "rect"|"ellipse"|"highlight",
             fill: "#ffffff" | null, fillOpacity, stroke: "#000000"|null, strokeWidth },
  ink:     { points: [ [dx, dy], … ], stroke, strokeWidth },  // 点为盒内相对 pt
  signature: { assetId, naturalW, naturalH }               // 图片承载，P1 画板生成
}

Page {
  id: "pg_<seq>",
  srcIndex: <int> | null,        // null = 新空白页（P1）；有值为原文件页号
  rotateDelta: 0|90|180|270,     // 相对原页 /Rotate 的增量，导出时叠加
  deleted: false
}

Asset { id, mime, w, h, dbKey: "asset:<sha256-16>" }   // 图片字节存独立 db key（base64）
Draft { schema:1, docId: "<原文件 sha256 前 16 位>", origName, savedAt,
        pages: [Page], overlays: [Overlay], assets: {id: Asset} }
```

要点：

- **白盒不是独立类型**——是 `shape.kind:"rect"` + `fill:"#ffffff"` 的语法糖（工厂函数 `makeWhiteout()`），减少类型分叉。
- **z 序 = 页内有序数组的显式字段**（而非数组下标隐式序）：撤销重排/插入对象时命令 diff 最小。
- 图片字节不内联进 Overlay JSON——草稿体积与对象图解耦，asset 走独立 db key，草稿只存引用（§7.3 预算治理）。

### 5.3 序列化与恢复

草稿 = Draft JSON 直接 `spark.db.set('draft:' + docId, draft)`。恢复条件：重开同一文件（bytes sha256 前缀 == docId）→ 提示「发现未导出草稿（n 分钟前），恢复/丢弃」；hash 不匹配 → 草稿列为孤儿，进 LRU 回收。schema 带 `schema:1` 版本号，model.js 载入时校验 + 拒绝降级（未知 schema 明确报错，不猜）。

## 6. 渲染与交互管线

### 6.1 页面虚拟化

- 打开时**只预取全部页尺寸**：循环 `getPage(i).getViewport({scale:1})` 取 `{w,h,rotate}` 后 `page.cleanup()` 释放代理，用尺寸先排出滚动布局（千页文档该循环为页字典级解析，实测秒级）。
- 滚动容器内每页一个 `div.page-frame`（px 尺寸 = viewport at scale）+ IntersectionObserver，**可视页 ±1 页渲染**，其余保留空白 frame（占位高度已知，无跳动）。
- 渲染队列：并发 2，按「距视口中心距离」出队；页离屏即 `renderTask.cancel()` + `page.cleanup()`；同一页的新渲染请求永远先 cancel 旧 task（防叠影——pdf.js 已知竞态）。

### 6.2 缩放：两段式（拍板）

- **手势期**（Ctrl+滚轮/滑块拖动中）：对 pages 容器整体 `CSS transform: scale(k)` —— 立即反馈，容忍轻微模糊；交互（命中/手柄）在手势期挂起。
- **落定期**（debounce 150ms）：按目标 scale 重算各 frame px 尺寸、逐页重渲染、覆盖物 DOM 重排（`left/top = pt × scale` 一次批量写），清掉 transform。
- **否决「全程 transform」**：canvas 位图在 k>1 时永久模糊、命中检测要过逆矩阵、pdf.js 文本层与覆盖层对齐漂移三宗罪。**否决「实时重渲染」**：连续滚轮每档都起 render task，大页必卡。
- 安全阀：目标渲染像素 `w×h ≤ 16M`（超出自动下调 scale 并提示），防止巨幅海报页 OOM（toolkit op-list 坑的同族风险，§8-R4）。

### 6.3 命中检测与选中

- 覆盖物本身是 DOM（div/img/svg），**事件由元素自身承接**（`pointerdown` 即选中）——不做全局几何命中，杜绝坐标双算。唯一的全局命中是**框选（marquee）**：空白处按下拖拽出 px 矩形，与各覆盖物 px 包围盒求交（geometry 提供 pt→px 后的纯矩形交）。
- 选中态：overlay-view 给选中对象挂 8 向手柄 + 旋转把手（P1）；拖动中只改 DOM（不进 store），`pointerup` 时**一次性**生成 update 命令入栈——撤销栈不被拖动中间态污染。
- 文本框编辑：双击进入 `contenteditable` 就地编辑；失焦时烘焙行（§7.2）+ 提交 update 命令。

### 6.4 撤销重做（命令模式）

```
Command = { label, do(), undo() }   // 闭包捕获 before/after 数据
栈策略：undo 栈上限 100（超出丢最旧）；任何新命令清空 redo 栈
命令粒度：
  add/remove     —— 携带整个 Overlay 快照（对象小，整存整取，不做字段级 diff）
  update         —— { overlayId, before:<字段patch>, after:<字段patch> }，仅记录变更字段
  pageList       —— before/after 两份 Page 数组快照（页面级操作频率低，整存）
  pages.rotate   —— { pageIds, delta }
合并（coalescing）：拖动/缩放只在 pointerup 提交一次；文本输入在失焦提交一次；
  连续同向微调字号（<300ms 间隔）合并为一条。
```

history.js 是纯数据结构（不触 DOM），Node 可单测：do/undo/redo 幂等往返、栈上限、redo 清空、coalesce 窗口。

### 6.5 页面加固与编辑快捷键协同（本插件的关键差异点，必须成体系）

冲突裁决原则——**加固段一票优先，编辑快捷键绕行设计，绝不放宽加固**：

| 键 | 加固行为 | 编辑器裁决 |
|---|---|---|
| F12 / F5 / Ctrl+P / Ctrl+Shift+I\|J\|C | 任何焦点都拦（capture） | 编辑器**永不**绑定这些键；"打印"用工具栏按钮 |
| Ctrl+R | 非编辑焦点拦（整页刷新） | **redo 用 Ctrl+Y / Ctrl+Shift+Z，明确禁用 Ctrl+R 语义**——对象选中时焦点不在 input/textarea，Ctrl+R 必撞加固；这条写进快捷键表注释防后人手痒 |
| input/textarea 豁免 | 保留系统右键菜单 | **本插件必须把豁免选择器扩为 `input, textarea, [contenteditable]`**——文本框就地编辑靠 contenteditable，不扩则编辑中右键粘贴被拦 |
| Ctrl+C/V/X/S/Z/Y/A/Del/Esc/方向键 | 加固不碰 | 编辑器快捷键自由使用 |

实现纪律（interact.js 内）：

1. **加固段最先注册**（capture 阶段），代码即宿主文档 §12 模板 + contenteditable 扩展，独立成段带注释「页面加固」标识（仓库统一惯例）。
2. 编辑器快捷键表为**集中声明的键表**（`SHORTCUTS = [{key, when, action}]`），单一 keydown 分发器在 bubble 阶段查表执行——禁止散落的 `addEventListener('keydown')`（否则加固豁免逻辑与快捷键逻辑两处打架）。
3. 分发器判 `when`：焦点在 contenteditable 内时只放行文本编辑类（Ctrl+B 等），对象类快捷键（Delete/对齐/z 序）要求焦点在画布。
4. 加固段与快捷键段的**协同契约测试进 dom-smoke**（§11）：模拟 keydown 断言 F12 被 preventDefault、Ctrl+Z 到达 history、contenteditable 内 Ctrl+R 不整页刷新语义。

## 7. 保存管线

### 7.1 通道拍板（基于宿主 API 面实测结论）

宿主 `spark.fs.write` 为**文本语义、单次 10MB 上限**——PDF 二进制不可用（base64 也会被 10MB 文本上限卡死，>7.5MB 的 PDF 全灭）。**拍板：不声明 fs.write，保存走 toolkit 已验证的 File System Access API 双通道**：

1. 主通道：`showSaveFilePicker({suggestedName})` → `createWritable().write(blob)`——WebView2 下弹系统另存为，用户可在对话框中**选择原路径完成覆写**（一次确认，语义诚实）；返回句柄短暂持有，不做持久授权（安全收敛）。
2. 兜底：`<a download>` 下载（toolkit saveBlob 同款，含 AbortError→'cancel' 分支）。
3. dirty 语义：任何命令入栈即 dirty；导出成功清 dirty；`spark.onClose` 里 best-effort 写草稿（防 onClose 异步存盘不可靠：自动保存 debounce 已把丢失窗口压到 ≤2s）。

### 7.2 导出合成管线（export.js）

```
export(doc: Draft + 原始bytes) -> Promise<Blob>
  1. PDFDocument.load(原始bytes)              // 加密文档在此明确抛错（打开期已检测）
  2. 按页模型构建页序列：copyPages(src, [srcIndex…]) → addPage
     空白页（P1）：embedPage 或 drawPage 到新 page
     rotateDelta：page.setRotation(degrees(原rotate + delta))
  3. 逐页烧录覆盖物（按 z 升序）：
     text  → embedFont(字体, {subset:true}) 缓存一份 → 逐行 drawText(line.text,
             { x, y: line.baseY + cropboxOffset, size, color })   // 行已烘焙，无重排
     image → page.drawImage(await doc.embedPng/Jpg(assetBytes), {x,y,w,h})
     shape → drawRectangle / drawEllipse（highlight = fillColor+opacity 0.35）
     ink   → drawLine 序列（P2 可换 drawSvgPath）
     元素级 rotate≠0：pdf-lib 旋转围绕锚点，沿用 toolkit engine.js 已验证的
             stampAnchor() 中心锚定几何（该函数可直接移植，纯函数有先例测试）
  4. 坐标总换算：全部 pt 值 + CropBox origin 偏移；Y 向上天然一致（存储即用户空间）
  5. doc.save({ useObjectStreams: true }) → Blob
```

**行烘焙（本方案最重要的防 bug 设计）**：浏览器 DOM 里文本框的换行断点，与导出时重新排版计算的断点**永远可能不一致**（字体度量微差）。拍板：**编辑提交时（失焦/命令入栈时）用 Range API 逐行取每行文本与其基线 pt 坐标，烘焙进 `overlay.text.lines[]`**；导出只按 lines 逐行 drawText，**导出端零排版逻辑**。这一刀把"导出后换行位置不对"整类 bug 从概率问题变成结构不可能。

### 7.3 中文字体方案（拍板）

| 项 | 决策 | 理由 |
|---|---|---|
| vendor 字体 | **思源黑体 SC（Noto Sans SC）TTF flavor，预子集到 GB2312 一二级 6763 字 + ASCII + 常用标点，约 2.5MB，Regular 一档**（OFL 许可，vendor 带 LICENSE_OFL） | 全量 TTF ≈10MB 太重；预子集把"运行时子集化"的输入压小 4 倍 |
| 形态 | **必须 TTF（glyf outlines），禁 OTF/CFF** | @pdf-lib/fontkit 对 CFF 轮廓的子集化有已知缺陷（pdf-lib #207 一族）；TTF glyf 路径成熟 |
| 嵌入 | `registerFontkit(fontkit)` + `embedFont(bytes, { subset: true })`，**每文档会话缓存一个 font 实例**，导出完随 pdf-lib 文档一起丢弃 | 输出只含用到的字形 |
| 内存评估 | 预子集 2.5MB 输入 + fontkit 解析/子集化峰值 ≈ 3–6×（10–20MB 瞬态），单次导出可接受；**不缓存跨文档 font 实例**（防常驻增长） | 数量级远低于 mupdf wasm 路线 |
| 兜底 | 提交时逐字符探测：glyph 超出预子集（生僻字/emoji）→ 该行导出降级为 canvas 高分辨率栅格化 PNG 烧录，编辑态 UI 标记"此段为图片导出" | 系统字体渲染所见 + 栅格化导出保证**不丢内容**，只是不可选中；诚实降级优于报错 |
| P1 | 增加 Bold 一档（预子集同规格） | P0 用 faux-bold（描边模拟）不进导出，导出仅 Regular——UI 需如实禁用加粗导出或走栅格化 |

水印先例（toolkit 用 canvas 全栅格化）在这里**不采为主方案**：编辑器输出的文本必须是可选中、可检索的真文本，否则"改字"功能自欺。

### 7.4 草稿自动保存（spark.db）

- 触发：命令入栈后 debounce 2s + `spark.onClose` + `visibilitychange→hidden`。
- 结构：`draft:<docId>` → Draft JSON（§5.3）；图片字节 → `asset:<hash>` 独立 key（base64），Draft 只存引用。
- **预算治理**（db 无文档化上限，自管）：单 asset ≤8MB（超限压缩/拒绝并提示）；每草稿 assets 总量 ≤40MB；全局保留最近 5 份草稿 LRU，超出删草稿连同名下 asset keys。
- 失败降级：`db.set` 抛错 → 状态条常驻「草稿保存失败，请及时导出」，不阻断编辑。

## 8. 性能策略与已知坑

| 风险 | 来源/先例 | 对策 |
|---|---|---|
| **R1 op-list 崩内存** | toolkit 实测：超长页面对象序列化（getOperatorList）OOM，engine.js 被迫封顶 120000 算子 | **本插件架构性禁用 `getOperatorList`**——只需 render() 与（P1）getTextContent，均按页惰性；此条写为 render.js 顶部约束注释 |
| **R2 CJK 文本层坐标偏移** | pdf.js 已知问题：CJK 字体下文本层 span 定位有偏差 | P0 **不建文本层**（不依赖其精确坐标）；「点原文建白盒」只用 `getTextContent` 的 item bbox 做**建议位置**，允许用户拖正——白盒预填是辅助不是承诺；P1 开文本层仅用于复制 |
| **R3 大文件内存** | pdf.js 文档常驻 + 双份字节 | 打开时复制一份字节喂 pdf.js（engine.js 先例：pdf.js 会转移 buffer）；pdf-lib 文档仅导出瞬间存在；页离屏 cleanup；关闭/换文档 `pdfDoc.destroy()` |
| **R4 渲染竞态叠影** | pdf.js 常见坑 | 同页新 render 必先 cancel 旧 task；cancel 后的 canvas 上屏前检查任务代际（每页维护 renderSeq） |
| **R5 巨页像素爆炸** | 海报页 scale 2 即上亿像素 | 渲染像素上限 16M，超限自动降 scale（§6.2） |
| **R6 fontkit 子集化翻车** | CFF/复杂字形 bug 族 | TTF-only 输入 + 导出冒烟含「3000 随机汉字压力用例」；崩则 Plan B：整字体嵌入不子集（2.5MB/文档，可接受）并记录决策笔记 |
| **R7 WebView2 FSA 缺失** | 环境差异 | toolkit saveBlob 双通道已在真机验证，照抄该分支结构 |
| **R8 onClose 存盘不可靠** | 异步回调 vs 关窗竞态 | 自动保存 debounce 压低丢失窗口（≤2s）+ onClose best-effort；不在 onClose 里尝试导出 PDF（必失败） |

## 9. 宿主契约：plugin.json 草案与打开通道

### 9.1 plugin.json（关键决策）

```json
{
  "id": "com.spark.pdf-editor",
  "name": "PDF编辑器",
  "version": "0.1.0",
  "api_version": 2,
  "runtime": "webview",
  "main": "index.html",
  "icon": "icon.svg",
  "permissions": ["notify", "clipboard"],
  "features": [
    { "type": "keyword", "keyword": "pdf编辑",  "title": "PDF编辑器",
      "subtitle": "改字 · 贴图 · 高亮 · 页面编排 · 留空回车选择文件",
      "mode": "page", "placeholder": "拖入或选择 PDF 文件开始编辑…" },
    { "type": "keyword", "keyword": "编辑PDF",  "title": "PDF编辑器" },
    { "type": "keyword", "keyword": "PDF编辑器", "title": "PDF编辑器" },
    { "type": "regex", "pattern": "(?i)\\.pdf$", "title": "PDF编辑器",
      "subtitle": "编辑此 PDF 文件（需选择确认）", "mode": "page" }
  ],
  "window": { "width": 1280, "height": 860, "min_width": 720, "min_height": 520,
              "resizable": true, "multi_instance": true }
}
```

- **keyword 选型**：`pdf` 已被 toolkit 占用（全局唯一先装先得），选 `pdf编辑`/`编辑PDF`/`PDF编辑器` 三别名，与 md-viewer 的多 keyword 先例一致。
- **permissions 只声明 `notify` + `clipboard`**：notify 用于长导出完成提醒；clipboard 用于对象复制粘贴与签名图粘贴。**不声明 fs.read/fs.write**——理由见 §9.2 与 ADR-4。
- **`multi_instance: true`**：编辑器会话强文档绑定，多开 = 多文档隔离，同 md-viewer 拍板先例。
- **window 尺寸取 UI 蓝图建议值**（1280×860 / min 720×520），与 UI 三档响应式断点配套。

### 9.2 三通道打开（关键拍板：路径直开的宿主限制必须诚实处理）

宿主 `spark.fs.read` 为**文本语义（UTF-8 lossy）+ 10MB 上限**——二进制 PDF 经它读入**必然损坏**（xref/流字节被 lossy 解码），且 10MB 上限拦掉大多数真实 PDF。这与 md-viewer（纯文本，fs.read 完美适配）前提根本不同。**拍板：不声明 fs.read，不承诺路径直开**：

| 通道 | 设计 |
|---|---|
| ① 唤醒词 | keyword 空参进入 → 空态拖放区（主通道，零高危权限，装好即用） |
| ② 路径感知（regex `\.pdf$`） | 粘贴路径 → 进入插件后展示「待打开：xxx.pdf」引导卡，一键唤起 `showOpenFilePicker`（用户在系统选择器中选中该文件）。**是引导不是直开**——subtitle 与引导卡文案如实写「需选择确认」 |
| ③ 手动选择 | 空态/工具栏「打开」按钮 → File API picker + 窗口拖放（dragover 全窗口接） |

被否决的方案及其最强理由：声明 fs.read 做路径直开（md-viewer 先例确实优雅）——但文本语义读二进制是**静默数据损坏**，比功能缺失恶劣得多；且高危授权弹窗换一个坏通道，得不偿失。**接口预留**：shell.js 的打开层抽象为 `openChannel(kind, payload)`，宿主若在未来开放二进制 fs 语义（fs v2），regex 通道可无缝升级为真直开——这是对宿主契约演进的唯一依赖点，隔离在 shell.js 单文件内。

### 9.3 加密文档策略

打开期 pdf.js 可探测加密（`PasswordException`）：空用户密码可开 → **编辑受限提示**（pdf-lib load 会对加密文档抛错，导出通道不可用 → 引导用户先经 pdf-toolkit 压缩重存出无加密副本再编辑——工具链内闭环）；有密码 → 直接明确报错，不做解锁。

## 10. vendor 资源清单（发布物机械核对基准）

| 路径 | 来源@精确版本 | 数量 | 说明 |
|---|---|---|---|
| `assets/vendor/pdf.min.js` | pdfjs-dist@3.11.174 (legacy) | 1 | 与 toolkit 同版本锁（ADR-6） |
| `assets/vendor/pdf.worker.min.js` | pdfjs-dist@3.11.174 | 1 | workerSrc 指向 |
| `assets/vendor/cmaps/*.bcmap` | pdfjs-dist@3.11.174 | **179** | CJK CMap，与 toolkit 同套 |
| `assets/vendor/cmaps/LICENSE` | 同上 | 1 | |
| `assets/vendor/standard_fonts/*` | pdfjs-dist@3.11.174 | **16** | Foxit×10 + Liberation×4 + LICENSE×2 |
| `assets/vendor/pdf-lib.min.js` | pdf-lib@1.17.1 | 1 | 与 toolkit 同版本锁 |
| `assets/vendor/fontkit.umd.min.js` | @pdf-lib/fontkit@1.1.1 (dist UMD) | 1 | 中文嵌入必需（ADR-5） |
| `assets/vendor/fonts/NotoSansSC-GB2312-Regular.ttf` | 思源黑体预子集 | 1 | ~2.5MB，TTF flavor |
| `assets/vendor/fonts/LICENSE_OFL.txt` | OFL 1.1 | 1 | 许可随行 |
| `assets/vendor/VENDORS.md` | 自写 | 1 | 仓库惯例：版本表+加载序 |

**机械核对清单**（提交前照 AGENTS.md §3 执行）：
1. `git add pdf-editor/0.1.0/` 整目录，`git status --short` 该目录必须无 `??` 残留；
2. `git ls-files pdf-editor/0.1.0` 条数 − 1 == signature.json `files` 条数（本插件重灾区就是 **cmaps 179 个 + 字体 TTF**，一个都不能漏）；
3. `node --check` 全部 js（vendor 除外）；`node tests/export-smoke.mjs` 全绿才可提交。

vendor 总量预估 ~12MB（cmaps ~1MB + pdf.js ~5MB + 字体 2.5MB + 其余），market zipball 可接受（toolkit 先例同量级）。

## 11. 风险清单与验证策略

### 11.1 测试分层（哪些逻辑 Node 可测 / 哪些必须 jsdom / 真浏览器）

| 层 | 环境 | 内容 |
|---|---|---|
| **纯 Node（零 DOM）** | `node tests/*.test.mjs` | geometry.js：pt↔px 往返恒等、4×旋转×CropBox 偏移矩阵、rect 对易；model.js：schema 往返/未知 schema 拒绝/白盒糖工厂；history.js：栈语义/合并窗口/上限 |
| **Node + PDFLib/pdfjs fake worker**（toolkit engine.js 先例：模块不触 DOM 顶层） | `node tests/export-smoke.mjs` | **导出坐标冒烟矩阵**：夹具 PDF {rot 0/90/180/270, CropBox≠MediaBox, CJK 文档} × 在已知 pt 放置文本/矩形/图 → 导出 → pdf.js 重开 → `getTextContent`/渲染断言位置容差 ≤1pt；**3000 随机汉字子集压力**（内存 + 正确性）；加密夹具报错断言 |
| **jsdom**（`.zcode/pdf-editor/dom-smoke.mjs`，linux-command 先例） | dom-smoke | 真实加载 index.html 全部 script + spark 桩：加固段拦 F12/Ctrl+P、Ctrl+Z 路由 history、contenteditable 内豁免、store 订阅驱动 overlay-view 更新、保存流调 FSA 桩、草稿写 db 桩 |
| **真浏览器 CDP**（trace-board ui-smoke 先例，可选） | `tests/ui-smoke.mjs` | 大文档滚动虚拟化、缩放两段式落位、png 截图基线 |
| **语法门** | 每次改动 | `node --check` 全部自写 js |

### 11.2 风险 → 开发期早发现手段

| 风险 | 早发现 |
|---|---|
| 坐标换算错位（含旋转/CropBox） | M1 geometry 单测 + M4 导出冒烟矩阵——**在写任何 UI 前就用夹具全跑** |
| 换行不一致（编辑所见 ≠ 导出所得） | 行烘焙设计使其结构不可能；dom-smoke 断言失焦烘焙 lines 非空 |
| CJK 文本层偏移 | P0 不依赖；P1 开发前先做「偏移观测夹具」（3 个真实中文 PDF 截图对比）再定文案 |
| fontkit 子集化崩 | M4 压力用例第一天就跑，不等到 P0 收尾 |
| op-list OOM 复发 | render.js 顶部约束注释 + code review 项 |
| cmaps/字体漏提交 | §10 机械核对三连，写进 PR checklist |
| 宿主 regex `(?i)` flavor | md-viewer 笔记已备案：加载期冒烟验证，fallback 显式大小写枚举 |

## 12. ADR 决策记录（汇总）

| # | 决策 | 理由 | Trade-off |
|---|---|---|---|
| **ADR-1 技术路线** | A 覆盖式 + 页面级结构操作为主；C 收敛为 A 文本框的多行回流；B 否决 | B 逐库死刑：pdf-lib 无文本层 API、mupdf.js AGPL 一票否决、hummus 无浏览器构建、CJK 子集字体原位重排 = 自写排版引擎；C 整页重排丢版式与编辑器定位冲突，其 Word 感内核（框内回流）A 已天然覆盖 | 原文不可原位改流；UX 契约必须向用户言明（白盒+预填糖补偿） |
| **ADR-2 坐标权威** | 存储 = 未旋转 PDF 用户空间，Y 向上；视图 px 仅临时值；换算收敛 geometry.js 纯函数；CropBox origin 统一偏移条款 | 缩放/页面旋转下覆盖物零重算；单点换算可矩阵测试；CropBox≠MediaBox 是隐藏地雷必须显式条款 | 每次事件多一层函数调用（可忽略）；开发纪律：模块外禁止 scale 算术 |
| **ADR-3 状态管理** | 手写集中 store + topic 订阅（~280 行），唯一写口 `apply()`；不用框架/Proxy 响应式 | 对象量级低（页内 <1k），全量重排 overlay DOM 成本可接受；无构建链约束下引框架 = vendor 膨胀 + 心智迁移；md-viewer/trace-board 同款已验证 | 精细 diff/调度能力没有——不需要；store 写口纪律靠 review 保证 |
| **ADR-4 保存通道** | FSA showSaveFilePicker 主 + 下载兜底；不声明 fs.write/fs.read | 宿主 fs 是文本语义 10MB 上限，二进制 PDF 必损坏/必超限；FSA 已被 toolkit 真机验证，零权限 | 「覆写原路径」需用户在对话框确认一次（诚实换取零高危授权）；草稿与导出双副本最终一致 |
| **ADR-5 中文字体** | vendor 预子集 Noto Sans SC **TTF**（GB2312+ASCII，~2.5MB）+ fontkit `subset:true`；glyph 缺字 → 该行栅格化降级 | TTF glyf 规避 fontkit CFF 子集化缺陷；预子集压小运行时输入；真文本导出保住可选中/可检索的编辑器底线；栅格化兜底保内容不丢 | 生僻字段降级为图片（UI 如实标记）；P0 无独立 Bold 字重 |
| **ADR-6 pdf.js 版本** | 锁 3.11.174 legacy 与 toolkit 同源 | UMD 直引符合无构建链铁律；cmaps/standard_fonts 布局与坑位已有仓库经验（op-list 等）；4.x 为 ESM-only 形态，迁移风险换不来编辑器所需的新能力 | 放弃 4.x 的部分渲染优化；未来升级是独立决策笔记 |
| **ADR-7 覆盖层形态** | 覆盖物用 DOM（div/contenteditable/img/svg）渲染，不用自绘 canvas 交互层 | 命中/焦点/文本编辑/右键豁免/无障碍浏览器全免费；文本就地编辑（Word 感核心）在 DOM 上是自然能力，自绘 canvas 则要自写输入法编辑框架（IME composition 绝对禁区） | 千级对象 DOM 压力 → 虚拟页外对象不建 DOM（页内数量实际低）缓解 |
| **ADR-8 行烘焙** | 文本框失焦时用 Range API 烘焙行文本+基线 pt 坐标入模型，导出零排版逻辑 | 消灭「编辑所见与导出换行不一致」整类 bug（字体度量微差不可调和，只能单边权威） | 富文本大改（字号变更）需重烘焙——本就是失焦提交路径，无额外成本 |
| **ADR-9 加固协同** | 加固段 capture 最先注册、永不放宽；编辑快捷键绕行（redo=Ctrl+Y，禁 Ctrl+R 语义）；豁免选择器扩 `[contenteditable]`；键表集中分发 | 满足仓库硬约束且编辑器快捷键体系完整；冲突键以绕行解决而非放宽 | "刷新页面"类快捷键永远不可用；redo 快捷键与 Word 习惯略偏（Ctrl+Y 亦为 Word 原生 redo，实际无损失） |
| **ADR-10 打开通道** | 三通道 = 空参唤醒 + regex 路径引导 + 手选/拖放；不承诺 fs.read 直开 | fs.read 文本语义对二进制 PDF 是**静默损坏**，比缺功能恶劣；零高危权限对"编辑用户重要文档"的工具是信任卖点 | 路径入口多一步确认；宿主 fs v2 若开放二进制语义，`openChannel` 已预留升级位（隔离在 shell.js） |

## 13. 给开发模型的施工纪律（实现约束收口）

1. **分层硬边界**：geometry/model/history/store 顶层禁触 DOM（Node 可测是测试策略的地基，破坏即测试策略坍塌）；视图层禁直接改 store 字段（一律经命令或 store.apply）；坐标算术只许出现在 geometry.js（code review 一票项）。
2. **文件纪律**：JS 单文件超 ~600 行必须按职责拆分；所有自写 js 过 `node --check`；每个 IIFE 模块头注释写明「本文件不依赖 DOM 顶层初始化」与否。
3. **提交纪律**：整目录 `git add`；signature.json 条数 = `git ls-files` − 1（重灾区：179 cmaps + 字体 TTF）；导出冒烟矩阵绿是保存按钮接线的前置条件（M4→M5 门禁）。
4. **决策留痕**：施工时 ADR-1/2/4/5 落地各写一篇 `.agents/notes/implemented/architecture/` 决策笔记（路线拍板/坐标基准/保存通道/字体方案），与代码同批提交；实现中推翻本方案任何一条，先转 `proposed` 笔记再动手。

关键参考文件：`docs/插件开发/WebView插件开发.md`（宿主 API 面/加固模板）、`pdf-toolkit/0.1.0/js/engine.js`（stampAnchor 旋转几何与 Node 可测先例）、`pdf-toolkit/0.1.0/js/app.js` 350–384 行（saveBlob FSA 双通道先例）、`.agents/notes/implemented/architecture/2026-09-16-mdviewer-entry-and-fs-read.md`（入口矩阵与高危权限取舍先例）。