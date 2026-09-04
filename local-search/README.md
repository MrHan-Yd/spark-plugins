# 本地搜索(local-search)

Spark native 插件:全盘**文件名**实时搜索。参考 uTools「本地搜索」的核心体验,按 Spark native **纯应用模型**实现——搜索框输入关键字 `find` 或 `本地搜索` 打开插件页面,页面内输入即搜、点击执行动作;exe 只在页面背后提供搜索与文件动作,不参与主搜索列表。

## 用法

搜索框输入 `find` 或 `本地搜索` → 回车打开搜索页 → 页面输入框里搜:

```
报告
报告 计划
报告 ext:pdf
.pdf          ← 单独扩展名:列出全盘该类型文件
报告 d:
```

- 空格分词,多关键词 AND(都在文件名里出现才算命中)
- `ext:pdf` 或 `.pdf` 过滤扩展名(`ext:tar.gz` 也支持);**单独输扩展名 = 浏览全盘该类文件**
- `d:` 限定盘符(只输 `d:` 没有关键词/扩展名时不出结果,页面给引导)
- ↑/↓ 选择结果,Enter 打开;Esc 清空

结果动作:打开(explorer,文件按默认程序/目录直接进)、打开文件位置(`explorer /select`)、复制路径、复制文件(CF_HDROP 语义,经 PowerShell `Set-Clipboard`)。

## 页面

- 大输入框即搜,命中的关键词与扩展名都高亮(区间由 exe 按 UTF-16 码元算好,JS 直接切片渲染)。
- 索引构建期间顶部进度条实时刷新(页面每 1.5s 轮询一次),百分比 = 已扫描量 / 上次全量扫描量(校准文件 `index-meta.json` 自我修正,盘内容变化后会自动重校准);首次没有基线时用流动动画代替,「已扫描 N 项」始终平滑增长。
- 构建期间输入框锁定(占位提示「索引构建中,建完即可搜索…」),建完自动启用并聚焦——索引没建完结果不完整,不让搜,避免误判「搜不到」。
- 每建完一个盘,该盘即纳入建完后的搜索范围(盘间并行构建)。
- 右上角「设置」抽屉:盘符勾选、排除目录、结果上限,保存即重建索引;另有「重建索引」按钮。
- 明暗主题切换,与仓库其它插件同一套设计令牌。

## RPC 方法(页面 ↔ exe)

页面 JS 经 `spark.rpc(method, args)` 调用,host 转发 `plugin.page`:

| method | args | 返回 |
|--------|------|------|
| `search` | `{ text, limit? }` | `{ hits: [{path,name,dir,is_dir,score,highlight}], filter_only, progress: {total,done,files,visited,pending,drive_ready} }`;`filter_only=true` 表示既无关键词也无扩展名(如仅 `d:`),页面展示引导 |
| `open` | `{ path }` | `{ ok: true }`(explorer 打开) |
| `reveal` | `{ path }` | `{ ok: true }`(explorer /select 定位) |
| `copy_path` | `{ path }` | `{ ok: true }`(Set-Clipboard 写文本) |
| `copy_file` | `{ path }` | `{ ok: true }`(Set-Clipboard -LiteralPath,CF_HDROP) |
| `get_config` | `{}` | `{ config, letters, path }`(letters 为当前枚举到的盘符) |
| `set_config` | `{ config }` | `{ ok: true }`(落盘 + 热更新 + 重建索引) |
| `rebuild` | `{}` | `{ ok: true }` |

## 索引与内存

- **不落盘**:索引只存在于插件进程内存。页面关闭 → `plugin.shutdown` → 进程回收 → 内存自动释放,磁盘零残留(仅配置文件几 KB)。
- **懒启动**:页面首次 `spark.rpc` 时 host 才 spawn 进程;不打开页面 = 零开销。
- **进程生命周期 = 页面生命周期**:关闭页面进程即退,下次打开页面会重建索引(构建期间搜索返回进度,建完的盘立即可搜)。
- **构建并行**:盘间并行 + 盘内按一级子目录子树并行(worker 池按核数减半、封顶 8),124 万文件约 10 余秒(SSD);机械盘受寻道限制提升有限。
- **不抢机器**:插件进程全程「低于正常」CPU 优先级 +「很低」I/O 优先级,遍历循环另有限速削峰——CPU 和磁盘都只捡前台剩下的用,弱机不卡。
- 配置改动(config.json mtime)在下一次搜索时热检测,自动重建索引;设置面板「保存并重建索引」同样触发。

## 配置

`%APPDATA%\Spark\plugins-data\com.spark.local-search\config.json`(生成于首次启动,重装插件不丢):

```jsonc
{
  "drives": { "C:": true, "D:": true },   // 默认全部 true,嫌内存占用自己改成 false
  "exclude_dirs": ["windows", "appdata", "node_modules", ...],  // 目录名,任意层级匹配
  "max_results": 50
}
```

- `drives` 里没有的盘(新接入的 U 盘等)默认纳入索引;想排除请显式写 `false`。
- 默认排除:Windows、Program Files、ProgramData、AppData、System Volume Information、$Recycle.Bin、node_modules、.git。
- 删除配置文件 → 下次 `get_config` 时按默认(全选)重新生成。

## 构建

```
cargo build --release
copy target\release\spark-plugin-local-search.exe 0.1.0\
```

发布物在 `0.1.0/`:`plugin.json` + `spark-plugin-local-search.exe` + `page.html` + `page.css` + `page.js` + `icon.svg`。开发模式:设置 → 插件 → 加载开发目录,选 `0.1.0/` 文件夹;搜索框输入 `find` 或 `本地搜索` 打开页面(开发者模式卡片上有「调试」可开 DevTools)。

冒烟测试(手动按 wire 协议驱动 exe,建完索引需几分钟):`cargo run --example smoke -- <搜索词>`。

## 已知限制

- 仅 Windows(explorer/PowerShell 依赖)。
- 只搜文件名,不做文件内容搜索(页面调用 5s 超时,全盘内容检索扛不住;后续版本可做限定目录的内容搜索)。
- 进程随页面关停,索引不常驻:每次打开页面冷启动重建(全盘遍历,期间搜索可用、返回进度;HDD 冷缓存约几千条/秒,大盘要几分钟)。
- 索引不存大小/修改时间(省内存),列表副行只显示所在目录。
- 搜索范围 = 进程启动时枚举到的盘符;会话中途新接入的盘要「重建索引」才纳入。
- 目录名排除按名字匹配任意层级,不支持通配/路径模式。