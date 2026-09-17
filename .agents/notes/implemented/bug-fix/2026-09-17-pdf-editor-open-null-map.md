# Agent Note: pdf-editor 打开链路真机四缺陷修复（null.map 崩溃 + 页 id 全重复 + suggested 遮蔽 + asset Promise 裂图）

Status: implemented
Class: bug-fix

## 背景

真机（Spark 宿主 WebView2）首测：打开任意 PDF 即弹「打开失败： Cannot read properties of null (reading 'map')」。code-diagnostician 独立诊断确认根因，并沿同一打开链路扫出另三处缺陷（其中一处修完崩溃后必然立刻发作）。四个缺陷全部源于**shell ↔ render/store 的接缝参数契约未定死**，dom-smoke 因无法真开 pdf.js 文档而未覆盖该链路（测试盲区，如实记录）。

## 决策

1. **openDocument 的 pages 参数契约归位**（render.js）：openDocument 只负责解析 + pageParams 提取，pages 可空；调用方 shell.openBytes 拿到 pageCount 构建页模型后**必须显式 setOrder(pages)**——buildFrame 唯一入口在 setOrder，漏调 = 画布静默空白（比崩溃更难追，诊断报告点名不可用 `pages || []` 兜底了事）。调用顺序铁律：`history.clear() → renderer.setOrder(pages) → store.change('doc-open')`——doc-open 的订阅方（overlayView.syncAll/thumbs）依赖 overlayLayerOf 可解析，frame 晚建会永久漏渲染。
2. **id 计数器宿主唯一 = store.state.counters**（store.js/shell.js）：原代码循环内每次传字面量新对象给 nextId，N 页文档所有页 id 全是 pg_1（导出时每个覆盖物盖章到每一页、删一页删光全部、草稿 parseDraft 拒绝哑火）。修复：store 初始 state 显式声明 counters，shell 用 withCounters()（即 store.get()）分配；doc-open 不重置 counters（跨文档续号天然防重）。
3. **saveNow 内同名 var 遮蔽函数**（shell.js）：`var suggested = ...` 函数级提升遮蔽 suggested() 函数，保存必炸 'suggested is not a function'（导出成功但文件没写盘，全链报废）。修复：删局部 var，直接调函数，注释防复发。
4. **草稿恢复收口唯一写口**（store.js/shell.js）：新增 'draft-restore' mutator（pages/overlays/assets/counters 原子替换 + 标脏），替代原先绕过 change() 的直改 state + 手动 dirty（ADR-3 违例点）。恢复后仍需显式 renderer.setOrder + syncAll（frame 重建与 DOM 重排的时序契约同 §1）。
5. **图片 asset src 异步回填**（overlay-view.js）：getAssetDataUrl 是 async（spark.db 读字节），直接 `img.src = url` 会塞进 "[object Promise]" 永远裂图；改 Promise.resolve().then 回填。
6. 打开加重入门 opening 标志（连续双开两次 openDocument 交错写状态的防护）。

## 放弃方案

- **render.openDocument 内部建默认页序**（pages 为 null 时自造 pg_1..n）：id 分配会与 store.counters 宿主分叉（诊断避坑提示 #2），草稿恢复后的高计数器场景必然再撞重复 id；契约归位让 id 分配单点化。
- **仅给 setOrder 加 null 兜底**：shell 不再调 setOrder，画布静默空白，比崩溃更难追（诊断 §2.1 明确否决）。

## 代价与后果

- 旧草稿（重复 pg_1）会被 parseDraft 拒绝并静默忽略——预期行为，无迁移。
- 回归全绿：verify-m1 69 + export-smoke 门禁 26 + dom-smoke 32；修复后需真机复测清单：≥2 页打开、缩略图跳转、第 2 页画白盒导出（只落第 2 页）、保存走通、跨文档撤销无残留、带草稿重开恢复。
- 留痕：本轮未过宿主（SPARK_TRACE_SESSION 空），无 @trace；@see 代码内注释锚点。

## 关联

- [[2026-09-17-pdf-editor-design]]（立项总拍板）、[[2026-09-17-pdf-editor-coord-system]]（ADR-2）
- 教训沉淀：**接缝参数契约（可空性/调用序/宿主唯一性）必须在模块头注释定死，测试盲区（无法桩真 pdf.js 文档打开）靠诊断 agent 推演补位**。