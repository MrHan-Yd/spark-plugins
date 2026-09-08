# PDF 工具箱（pdf-toolkit）

Spark 离线 PDF 处理插件。全部处理在本地 WebView 内存中完成，**文件不上传、不联网、零痕迹**。

## 功能（9 项）

| 分组 | 功能 | 说明 |
|------|------|------|
| 文档处理 | PDF 压缩 | 三档强度（轻度/标准/强力）。轻度=对象流重存+删元数据；标准/强力会重压文档内 JPEG 图片（浏览器原生解码→缩放→重编码），矢量文字不损失 |
| | PDF 合并 | 多 PDF + JPG/PNG 混合合并；可视化页面画板：拖拽排序、逐页旋转、复制、删除 |
| | PDF 拆分 | 每页一档 / 每 N 页一档 / 自定义页码范围（`1-3, 5, 8-`） |
| | PDF 水印 | 文字水印，可调字号/颜色/透明度/旋转角度/九宫格位置，支持平铺与批量；实时预览 |
| 导出与提取 | 提取图片 | 枚举内嵌图片 XObject；JPEG 按原始字节提取（不重压缩），Flate 原始像素转 PNG；JPX/CCITT 等编码跳过并提示 |
| | PDF 转图片 | 逐页渲染 PNG/JPEG，4 档分辨率，支持页码范围，多页打包 ZIP |
| 格式转换 | 转 Word | 文本行聚类→段落（字号推断标题层级）；**带完整框线的简单表格还原为可编辑 Word 表格**（按原列宽分格）；按源页分页，生成 .docx |
| | 转 PPT | 每页渲染为高清图片帧，16:9/4:3 版式 1:1 还原，生成 .pptx |
| | 转 Excel | 文本坐标聚类还原行列网格，每页独立工作表或汇总模式，生成 .xlsx |

## 转换能力边界（诚实声明）

- **转 Word/Excel** 只适用于**文本型 PDF**。扫描件/纯图片 PDF 无文字层，会明确报错提示先走 OCR。
- 排版还原为"尽力而为"：段落、标题层级、字号、分页还原；**横竖框线齐全的简单表格**还原为真 Word
  表格（从 PDF 矢量框线重建，列宽按比例保留），缺边框时收缩为较小网格、合并单元格的局部线被忽略
  （内容并入邻近格）；无边框表格/多栏/图片/颜色/字体不还原，建议人工核对。
- 加粗/斜体：按字体名推断的管线已就位，但 pdf.js 3.11 文本层只提供通用字体族名（sans-serif 等），
  拿不到真实字体名，暂不生效（合成用例可验证管线本身）。
- 转 PPT 为整页图片版式，视觉 1:1 还原但文字不可编辑。

## 技术形态

webview 插件（`api_version: 2`），离线 vendor 库见 `0.1.0/assets/vendor/VENDORS.md`：

- 结构操作（合并/拆分/水印盖章/压缩/图片提取）：pdf-lib
- 解析/渲染/文本提取：pdf.js（含 cmaps + standard_fonts，中文 PDF 与标准字体全覆盖）
- 水印文字：Canvas 按系统字体（Microsoft YaHei 等）栅格化为透明 PNG 后盖章，无需 vendor CJK 字体
- 转换：docx / pptxgenjs / SheetJS；多文件输出打包：JSZip

## 文件结构（AGENTS.md 三件套 + 按职责拆分）

```
pdf-toolkit/0.1.0/
  plugin.json  index.html  style.css  icon.svg  signature.json
  js/
    app.js     # UI 外壳：路由/拖放/进度/保存(ZIP)/启动
    tools.js   # 各工具处理流程与选项持久化
    merge.js   # 合并可视化页面编辑器
    engine.js  # PDF 引擎（pdf-lib/pdf.js）
    convert.js # Word/PPT/Excel 转换
  assets/vendor/
```

## 触发

主输入框输 `pdf` / `PDF工具箱` / `PDF处理` + 回车。

## 冒烟

Node 对拍（fixture PDF 全流程真实执行）：`D:\demo\test01\_vendortmp\pdf-smoke\test-engine.js`（53 项，
含表格识别纯函数与真实 PDF→docx 表格结构校验）；
外壳 jsdom（装配/路由/合并编辑器交互/[hidden] 样式兜底）：同目录 `test-shell.js`（20 项）。

## 已知边界

- 压缩只重压 DCTDecode（JPEG）图片与对象流；Flate/JPX/CCITT 编码图片保持原样（浏览器无对应原生解码）。
- 提取图片不支持 JPX(JPEG2000)/CCITT/Indexed/带预测器的 Flate。
- PPT 输出无文字层；Word/Excel 不处理扫描件。
- 保存优先弹系统"另存为"（File System Access API），WebView2 不支持时回退浏览器下载。

## 签名状态

已签名（2026-09-08，`spark-official-v1` Ed25519，JS 归档 `js/` 后的当前布局）：`0.1.0/signature.json` 内含 202 个文件的 SHA-256 清单与签名值，registry 中该版本 `signature` 已嵌入同值。发布物文件如有改动需重新签发。