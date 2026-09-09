# Hosts切换 (hosts-switcher)

Spark native 插件:把系统 hosts 拆成「公共配置 + 多套自定义方案」,勾选合并后一键写入,
双击方案立即切换。所有处理在本地完成,不联网。

## 功能

- **公共配置**:首次使用插件时,自动读取系统现有 hosts(`%SystemRoot%\System32\drivers\etc\hosts`)
  的内容作为公共配置;之后在插件内独立维护,可随时编辑或「从当前系统 hosts 重新导入」。
- **自定义方案**:自由创建 hosts 片段(如开发环境 / 测试环境 / 内网调试),支持
  编辑、重命名、复制副本、删除(右键菜单或行内按钮)。
- **合并写入**:勾选一个或多个方案,与公共配置合并后整文件写入系统 hosts;
  合并结果可在「预览合并」中先看后写。未勾选任何方案 = 仅写回公共配置。
- **双击即切**:双击方案 → 自动勾选并立即写入 hosts。
- **公共配置备份**:公共配置编辑器里一键备份——txt 落到**插件安装目录 `backups/`**,
  同时作为「备份」条目显示在列表中:点击可只读查看,可转为方案、恢复为公共配置、删除
  (条目与备份文件联动,最多保留 20 份,超出自动清最旧)。
- **安全网**:每次写入前自动把当前 hosts 备份到同目录 `hosts.spark-backup`;
  写入后自动刷新系统 DNS 缓存(`ipconfig /flushdns`,浏览器内部缓存仍需手动清理,见页面帮助)。
- **外部改动检测**:hosts 在插件外被修改后,状态栏会提示重新应用。
- **明暗主题**、**vim 模式编辑**(hjkl/w/b/e、dd/yy/p、x、o/O、u、`:w` 保存等,
  不支持数字倍率/可视模式/搜索)。

## 形态与结构

native 插件(纯应用模型):exe 负责读写 hosts、方案配置持久化、DNS 刷新;
页面跑在 WebView2,经 `spark.rpc` 调用 exe。

```
hosts-switcher/
├── Cargo.toml            # Rust 源(serde/serde_json,零其它依赖)
├── src/
│   ├── main.rs           # 入口 + plugin.page RPC 路由(get_state/apply/scheme CRUD/export_base/…)
│   ├── proto.rs          # wire 帧编解码(4 字节小端长度 + JSON-RPC)
│   ├── hosts.rs          # hosts 读写/备份/合并/可写探测/DNS 刷新/备份目录定位
│   └── config.rs         # 配置(公共配置 + 方案 + 备份条目 + 勾选状态),存 Spark 插件数据目录
├── examples/smoke.rs     # 冒烟:target/smoke-fixture 临时 hosts + 配置,不碰系统文件,跑完自清
├── tests/vim-test.mjs    # vim 键位层 Node 行为测试
└── 0.1.0/                # 发布物
    ├── plugin.json       # 清单(api_version 2,main=exe,page=page.html)
    ├── spark-plugin-hosts-switcher.exe
    ├── page.html / page.css / page.js / editor.js / vim.js
    ├── icon.svg
    └── backups/          # 运行期生成:公共配置备份 txt(随「备份公共配置」产生)
```

配置文件:`%APPDATA%\Spark\plugins-data\com.spark.hosts-switcher\config.json`(重装插件不丢)。

## 开发

```bash
cargo test                      # 合并/配置单元测试
cargo build --release           # 构建后把 target/release/spark-plugin-hosts-switcher.exe
                                # 复制进 0.1.0/(文件名与 plugin.json 的 main 一致)
cargo run --example smoke       # 冒烟:经 SPARK_HOSTS_PATH / SPARK_HOSTS_CONFIG
                                # 环境变量重定向到临时文件,验证全 RPC 链路
node tests/vim-test.mjs         # vim 键位层行为测试(需 Node 18+)
node --check 0.1.0/page.js 0.1.0/vim.js
```

> 环境变量 `SPARK_HOSTS_PATH` / `SPARK_HOSTS_CONFIG` 仅供冒烟测试重定向路径,
> 发布链路不要设置。

## 签名状态

0.1.0 发布物**尚未签名**(registry `signature: null`)。按仓库签名规范
(Ed25519 / spark-official-v1)对发布物完成内容清单签名后,把 `signature.json`
写入包内并同步 registry `versions[0].signature` 四字段;此后任何发布物文件改动都需重签。

## 权限说明

`permissions: []`——写 hosts、刷新 DNS 均由自家 exe 完成,不经 host 鉴权;
页面未申请 clipboard/notify 等能力。