# assets/vendor — 第三方离线资源

本目录内的文件为第三方库及其派生数据，随插件一起打包以支持**完全离线**使用。

| 文件 | 来源 | 版本 | 许可证 |
|------|------|------|--------|
| `bcrypt.js` | npm `bcryptjs`（dcodeIO） | 2.4.3 | MIT |
| `jsqr.js` | npm `jsqr`（Cozmo/jsQR） | 1.4.0 | Apache-2.0 |
| `sm-crypto.js` | npm `sm-crypto`（JuneAndGreen），sm2/sm3/sm4 三个 UMD 模块合并，暴露 `window.SM` | 0.3.13 | MIT |
| `qrcode.js` | npm `qrcode-generator`（kazuhikoarase），含 UTF-8 覆写，暴露全局 `qrcode` | 1.4.4 | MIT |
| `jsbarcode.js` | npm `jsbarcode`（lindell），全格式打包，暴露全局 `JsBarcode` | 3.11.6 | MIT |
| `jsyaml.js` | npm `js-yaml`（nodeca），暴露全局 `jsyaml` | 4.1.0 | MIT |
| `pinyin-dict.js` | 由 npm `pinyin-pro` 的字典数据导出的单字常用音（格式 `字\|han4\|…`） | — | MIT（数据派生） |
| `s2t.js` / `t2s.js` | 由 `opencc-js`（OpenCC 数据）导出的单字映射（格式 `字\|字\|…`） | — | MIT AND Apache-2.0（数据派生） |

以上均为经典 UMD/全局脚本（无 ESM import），兼容插件页面的 `file://` 加载方式。