# 新插件：内容对比（com.spark.compare）— webview 方案

仿 uTools「万物皆可对比」的 Spark 版。**运行时用 webview（HTML）**：Native 一期只支持 list 模式、开不了窗口，且对比工具纯 UI+文本处理，FileReader/剪贴板已覆盖全部系统能力，无需 exe。

## 已确认的决策
- 范围：文本对比 + 剪贴板一键填充 + 文件拖拽（JSON 语义对比留后续版本）
- 关键字：`diff` 和 `对比` 两条入口
- 本次不签名，registry `signature: null`

## 新增文件
```
compare/0.1.0/
  plugin.json   # id com.spark.compare，name 内容对比，runtime webview，api_version 2
                # permissions ["clipboard"]；features: "diff" + "对比" 两条 mode:page 入口
                # window 1120×720 可缩放
  index.html    # 单文件零依赖页面
  icon.svg      # 现代扁平图标：双栏 + 绿−红 差异标记
```

## 界面设计（全新设计，不参考 json-formatter）

**设计方向「Aurora」：深色优先的现代工作台，附亮色主题切换**

- 视觉基调：中性深底（#0B0E14）+ 靛蓝 accent（#6C8CFF），亮色主题为纸白底（#F7F8FA）+ 同系 accent；细边框卡片、柔和阴影、圆角、克制的微动效（按钮 hover 抬升、Toast 滑入、拖入高亮呼吸、差异行渐显）
- 字体：Segoe UI Variable/Inter 系统栈 + Cascadia Code/JetBrains Mono 等宽栈（全部本地字体，不引外部资源）
- 布局（参考 diffchecker/GitHub compare 的成熟模式）：
  ```
  ┌ 顶栏：品牌 · 视图切换(并排/上下 segmented) · 选项胶囊(忽略空白/忽略大小写) · 主题 ┐
  ├ 输入区（可折叠）：左 textarea ⋮分割条⋮ 右 textarea，各带「📁文件 / 📋剪贴板」小按钮  │
  ├ 结果区（占主体）：差异渲染视图，右下角悬浮差异导航胶囊 ◀ 3/7 ▶                    │
  └ 状态栏：N 处差异 · +n/−n 行 · 相似度% · 耗时 · 文件名 chips                      ┘
  ```
- diff 配色走 GitHub 风格：新增行淡绿底+左缘绿条、删除行淡红底+左缘红条、词级差异用深一号的高亮圆角片
- 空态：居中 SVG 插画（两份文档+双向箭头）+ 一句引导文案

## Diff 引擎（自研，零依赖）

- 行级：掐头去尾公共前缀/后缀 → 中间段 Myers O(ND) + 回溯
- 词级：replace 块内按词切分再跑 Myers，行内 <ins>/<del> 高亮
- 防护：单侧 >5000 行时中间段整体记为差异块并提示「内容过大」；渲染行数预算超限省略；\r\n/\r 统一归一为 \n
- 算法先在临时 node 脚本跑用例（相同/空输入/中文/交错增删）验证，再内联进 HTML

## 交互与代码组织

- 输入 300ms 防抖实时对比；选项/视图切换即时重算
- 剪贴板→左/右：spark.clipboard.readText 优先回退 navigator.clipboard，Toast 反馈
- 交换左右、清空、复制差异（unified 文本 + 三级复制回退链）
- 文件拖拽：drop 高亮 → FileReader 读文本填入对应侧（纯 Web API 免 fs 权限），文件名显示为 chip；另有文件选择按钮兜底
- 差异导航：◀ ▶ 循环跳转，scrollIntoView
- 打开时 spark.input.text 填入左侧；所有 spark.* 调用 window.spark 判空保护
- JS 用 state 对象 + 渲染函数 + 事件委托组织（比 json-formatter 的裸变量更进一步），仍保持单 `<style>`+单 `<script>`；动态行一律 createElement+textContent 防 XSS

## registry.json 更新
- plugins[] 追加：path `compare/0.1.0`，url/sha256/size null（走 zipball），released 2026-08-28，signature null，icon 指向 raw.githubusercontent 绝对 URL
- 顶层 updated 刷到 2026-08-28T00:00:00Z

## 不做的事
- 不 git commit（沿用惯例，等你吩咐）
- 不签名；JSON 语义对比留 0.2.0

## 验证
- node 临时脚本验证 diff 算法用例与 registry/plugin.json JSON 语法
- 浏览器直接打开 index.html 做界面冒烟（spark.* 有判空保护，浏览器可跑）