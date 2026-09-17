# assets/vendor — 离线第三方资源

全部为 UMD/经典脚本或二进制资源（`<script src>` 直载 / 相对路径引用），来源 npm 精确版本，无任何 CDN 依赖，运行期零网络。加载顺序见 `index.html` 底部 script 序。

| 文件 | 全局 | 来源包@版本 | 用途 |
|------|------|-------------|------|
| `pdf.min.js` | `pdfjsLib` | pdfjs-dist@3.11.174 (legacy/build) | PDF 解析/渲染/文本提取；与 pdf-toolkit 同版本锁（ADR-6） |
| `pdf.worker.min.js` | （worker） | pdfjs-dist@3.11.174 | pdf.js Worker 脚本，`GlobalWorkerOptions.workerSrc` 指定 |
| `cmaps/`（169 项含 LICENSE） | — | pdfjs-dist@3.11.174 | CJK CMap 资源（中文 PDF 渲染/文本提取必需），`cMapUrl` 指向此目录；与 pdf-toolkit 同套复制 |
| `standard_fonts/`（16 项） | — | pdfjs-dist@3.11.174 | 标准 14 字体数据（未内嵌字体的 PDF 渲染必需），`standardFontDataUrl` 指向此目录 |
| `pdf-lib.min.js` | `PDFLib` | pdf-lib@1.17.1 | 导出合成：copyPages 页序重建/覆盖物烧录/保存；与 pdf-toolkit 同版本锁 |
| `fontkit.umd.min.js` | `fontkit` | @pdf-lib/fontkit@1.1.1 (dist UMD) | `registerFontkit` 中文字体嵌入（子集化） |
| `fonts/NotoSansSC-GB2312-Regular.ttf` | — | Noto Sans SC（Windows 预装 VF 固化 wght=400） | 2.43MB；GB2312 全表+ASCII 预子集静态 TTF（glyf、无 fvar），生成脚本 `.zcode/pdf-editor/gen-font.mjs`（dev-only，不入包） |
| `fonts/LICENSE_OFL.txt` | — | SIL OFL 1.1 | Noto 字体许可随行 |

版本锁定理由：pdf.js 4.x 为 ESM-only 形态，不满足无构建链 UMD 直引；3.11.174 与
pdf-toolkit 同源，cmaps/standard_fonts 布局与已知坑位（op-list OOM、CJK 文本层偏移）已有仓库经验。
缺字兜底：预子集未覆盖的生僻字行经 canvas 栅格化 PNG 烧录（shell.js rasterizeLine），内容不丢。