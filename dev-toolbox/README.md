# 开发工具箱（dev-toolbox）

Spark webview 插件：**47 个离线开发常用工具**，8 个分组一个侧栏。搜索框输入 `tool` / `dev` / `开发工具箱` 打开；页面内左栏可按名称/别名过滤（如输 `base64`、`时间戳`、`sm2` 直达工具）。全部计算在本地完成，不联网、不上传任何输入内容。

## 工具清单

| 分组 | 工具 |
|------|------|
| 编解码 (10) | Base64、URL 编解码、Unicode 转换、ASCII 转换、字符串↔Hex、Hex↔Base64、HTML 实体、进制转换、原码反码补码、JWT 解码 |
| 加密哈希 (9) | 哈希计算（MD5/SHA1/SHA256/SHA512/SM3，支持批量与文件）、AES、DES、TripleDES、RC4、Rabbit、SM2 国密（密钥对/加解密/签名验签）、SM4 国密、Bcrypt（哈希与校验） |
| 文本处理 (8) | 文本统计、大小写转换、行处理（去重/排序/行号/删空行…）、文本替换（正则）、变量命名转换、汉字转拼音、简繁转换、中英标点 |
| 时间日期 (3) | 时间戳转换、日期计算（相差/加减）、Cron 解析（含义 + 未来 5 次执行时间） |
| 代码格式 (8) | JS / CSS / HTML(XML) / SQL 格式化与压缩、Markdown 整理、XML↔JSON、YAML↔JSON、JSON↔PHP 数组/properties/serialize |
| 网络计算 (2) | IP 子网计算（网络号/广播/可用主机/掩码各进制）、HTTP 状态码速查 |
| 生成工具 (6) | UUID v4 批量、ULID 生成（含时间解码/同毫秒单调递增）、随机字符串/密码、二维码生成（SVG）、二维码识别（本地 jsQR 解码）、条形码生成（CODE128/EAN13 等 9 种格式） |
| 单位换算 (1) | 14 类单位换算（长度/面积/体积/质量/温度/压力/功率/能量/密度/力/时间/速度/数据存储/角度） |

功能取舍：JSON 查看/格式化由 json-formatter 插件覆盖、文本差异对比由 compare 插件覆盖，本插件不做重复功能；代码格式组提供的是格式化互转（JSON 树形查看请用 json-formatter）。

## 特性

- **完全离线**：第三方库全部随包内置（`assets/vendor/`，见 [VENDORS.md](0.1.0/assets/vendor/VENDORS.md)）：bcrypt.js、sm-crypto（SM2/SM3/SM4）、qrcode-generator、jsQR、JsBarcode、js-yaml、pinyin-pro 字典数据、OpenCC 简繁数据。
- **输入即算**：IO 型工具输入框打字实时出结果，带「交换」（输入输出互换）与一键复制；错误在输出区红框提示。
- **明暗双主题**：与仓库其它插件同一套 design token，右上角/侧栏底部切换并记忆。
- **图标全部描边 SVG**（currentColor），不依赖位图资源。

## 结构（`0.1.0/`）

- 根目录：`index.html` + `style.css` + `plugin.json` + `icon.svg`，外壳 `app.js`（注册/侧栏/路由/主题）与 `ui.js`（组件库 + `UI.ioTool` 通用输入输出页工厂）
- `engine/`（纯计算，无 DOM，node 对拍 725 项测试）：`codec.js` `crypto.js` `cipher.js` `textkit.js` `format.js` `serial.js` `datetime.js` `netcalc.js` `units.js`
- `tools/`（只做装配，调引擎）：`tools-codec.js` `tools-crypto.js` `tools-text.js` `tools-time.js` `tools-code.js` `tools-net.js` `tools-gen.js`
- `assets/vendor/`：随包内置的第三方库（见 [VENDORS.md](0.1.0/assets/vendor/VENDORS.md)）
- SM2 密文为 C1C3C2 模式、输出带 `04` 前缀（解密自动兼容带/不带前缀）；SM4 密钥为 32 位 Hex。

## 签名状态

已签名（2026-09-07，`spark-official-v1` Ed25519）：`0.1.0/signature.json` 内含 32 个文件的 SHA-256 清单与签名值，registry 中该版本 `signature` 已嵌入同值。发布物文件如有改动需重新签发。