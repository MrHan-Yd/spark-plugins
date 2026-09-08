# assets/vendor — 离线第三方库

全部为 UMD/经典脚本（`<script src>` 直载、暴露全局），来源 npm 精确版本，无任何 CDN 依赖。
插件页以 `https://plugin.spark.invalid` 虚拟主机加载，同源相对路径引用。

| 文件 | 全局 | 来源包@版本 | 用途 |
|------|------|-------------|------|
| `pdf.min.js` | `pdfjsLib` | pdfjs-dist@3.11.174 (legacy/build) | PDF 解析/渲染缩略图/逐页转图/文本提取（渲染引擎与 Chrome 同源 PDFium 系实现） |
| `pdf.worker.min.js` | （worker） | pdfjs-dist@3.11.174 | pdf.js Worker 脚本，由 `GlobalWorkerOptions.workerSrc` 指定 |
| `cmaps/` | — | pdfjs-dist@3.11.174 | CJK CMap 资源（中文 PDF 文本提取必需），`cMapUrl` 指向此目录 |
| `standard_fonts/` | — | pdfjs-dist@3.11.174 | 标准 14 字体数据（未内嵌字体的 PDF 渲染必需），`standardFontDataUrl` 指向此目录 |
| `pdf-lib.min.js` | `PDFLib` | pdf-lib@1.17.1 | PDF 结构操作：合并/拆分/水印盖章/压缩重存/内嵌图片提取 |
| `jszip.min.js` | `JSZip` | jszip@3.10.1 | 多文件输出打包 ZIP |
| `xlsx.full.min.js` | `XLSX` | xlsx@0.18.5 (SheetJS) | PDF → Excel 生成 xlsx |
| `pptxgen.bundle.js` | `PptxGenJS`（内置打包 JSZip） | pptxgenjs@3.12.0 | PDF → PPTX 生成（整页图片版式） |
| `docx.umd.js` | `docx` | docx@8.5.0 (build/index.umd.js) | PDF → Word 生成 docx |

加载顺序：`pdf.min.js` → `pdf-lib.min.js` → `jszip.min.js` → `xlsx.full.min.js` → `pptxgen.bundle.js` → `docx.umd.js` → `engine.js` → `convert.js` → `app.js`。

水印不依赖字体库：文字经 Canvas 以系统字体（Microsoft YaHei 等）栅格化为透明 PNG 后由 pdf-lib 盖章，无需 vendor CJK 字体文件。