# 密码管家 · 第三方离线资源

| 文件 | 来源 | 版本 | 许可证 |
|------|------|------|--------|
| `bcrypt.js` | npm `bcryptjs`（dcodeIO），与 `dev-toolbox/0.1.0/assets/vendor/bcrypt.js` 逐字节一致（`cmp` 校验） | 2.4.3 | MIT（文件头注释标注 Apache-2.0，为作者旧版 bcrypt.js 的声明，两者均为宽松许可） |

`bcrypt.js` 是经典 UMD 脚本（无 ESM import），兼容插件页面的 `file://` 加载方式，暴露全局
`window.dcodeIO.bcrypt`。本插件只用到 `genSaltSync` / `hash` / `hashSync` / `compareSync`。

AES-256-CBC 与 SHA-256 **不引入**第三方库：`crypto.js` 的密码学核心机械抽取自本仓库
`dev-toolbox/0.1.0/engine/cipher.js` 与 `engine/crypto.js`（见该文件头部注释）。
