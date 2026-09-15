# 时间转换 · UI/UX 设计蓝图

> ui-designer 产出 · 2026-09-15 · 对应 `time-converter/0.1.0`（webview / vanilla / 零网络）
> 基线文件：`0.1.0/index.html`(167 行) · `0.1.0/style.css`(533 行) · `0.1.0/app.js`(414 行) · `engine.js`(不动)
> 窗口事实：默认 900×660，最小 560×420，可调；DOM/ID 结构已逐行核对，本蓝图 95% 为 CSS 层改动。

---

## 0. 现状核对与三处必改缺陷（设计前置）

| 项 | 现状 | 蓝图口径 |
|---|---|---|
| 卡片网格 | `minmax(340px,1fr) gap 12` | 改 `minmax(320px,1fr) gap 12`（900 宽下仍是 2 列，但 3 列门槛从 1076 降到 1028） |
| `[hidden]` 失效 | `.cards{display:grid}` 与 `.badge{display:inline-block}` 覆盖 UA 的 `[hidden]{display:none}` → 空闲态会露出空白卡片与空徽标 | **必须**在 tokens 段加 `[hidden]{display:none !important}` |
| 世界时钟行标签 | `.row-label{width:40px}`，`America/New_York` 必然溢出/挤压数值 | `.row-label.wc-label` 单独定宽（见 §3.8） |
| 主题按钮 | emoji 文本由 `app.js` 的 `textContent` 写入 | 用 `#btn-theme{font-size:0}` + `html[data-theme]` 选择器切 mask 图标，**零 JS 改动** |
| 滚动跳动 | 空闲→结果时滚动条出现会挤动卡片宽度 | `.stage{scrollbar-gutter:stable; overflow-anchor:none}` |

---

## 1. 设计概念

**一句话主题**：**「时间总线 / Time Bus」**——输入是唯一的时间源点，十张卡是它在十个"时间域"上的投影；界面是一块深空玻璃仪表台：**青碧色只标记"可操作"**（可点、可复制、可回填、焦点），**琥珀色只标记"源头与现在"**（原始精度行、现在按钮、相对/边界说明），**一切数值等宽成列，如仪表读数**。

### 1.1 Accent 换色决策（绿 → 青碧）

保留绿色族，但把色相从黄绿推向青碧（`#2f9e6e`/`#4fbf8f` → `#10a97a`/`#35d3a1`），理由：

1. **品牌连续**：与 `icon.svg` 的绿环 `#8fd68a` 同族，不改插件图标；同时把与图标箭头琥珀 `#f2a04b` 的色相分离度从约 30° 拉到约 50°，双色并置不再"糊成一片绿黄"。
2. **避免撞色**：仓库中 code-calc 独占暖琥珀、json-formatter 独占靛蓝，时间转换留在绿色带可保持三插件辨识度。
3. **对比度更稳**：新青碧在深底 9.2:1、浅底 5.3:1 同时达标；"亮底 + 深墨字"的分段按钮在明暗两主题下同构（见 §2.5）。

### 1.2 布局示意（900×660 默认窗口）

```
┌────────────────────────────────────────────────────────────────────────────┐
│ (1) TOP      50px   [时钟 mark] 时间转换          现在  清空  帮助   [主题]  │  7.6%
├────────────────────────────────────────────────────────────────────────────┤
│ (2) HERO    ~96px  ┌────────────────────────────────────┐ ┌─────────────┐  │
│                    │ 1700000000                         │ │ 本地 │ UTC  │  │ 14.5%
│                    └────────────────────────────────────┘ └─────────────┘  │
│                    (o) 识别为 Unix 秒              badge 20px              │
├────────────────────────────────────────────────────────────────────────────┤
│ (3) STAGE   flex:1 ┌────────────────────┐ ┌────────────────────┐           │
│     唯一滚动区      │ Unix 时间戳     ⧉ │ │ ISO 8601 (UTC)   ⧉↩│           │ 73.3%
│     484px @660     │ 秒   1700000000   │ │ 2024-01-01T04:30:… │           │
│     2 列 @900      │ 毫秒 1700000000…  │ │                    │           │
│     min320 gap12   │ 微秒 ·原始(琥珀)  │ └────────────────────┘           │
│                    └────────────────────┘   …… 共 10 卡流式排列 ……        │
├────────────────────────────────────────────────────────────────────────────┤
│ (4) STATUS   28px  (o) 来源 ISO 8601 · 精度 秒 · 系统时区 UTC+08:00        │  4.2%
└────────────────────────────────────────────────────────────────────────────┘
                                        ┌───────────────────────────────┐
        帮助打开时：scrim + blur(2px)    │ 抽屉 392px（右侧内缩 10px）    │
                                        └───────────────────────────────┘
```

### 1.3 响应式断点（窗口宽 → 卡片列数）

| 窗口宽 | stage 内容宽 | 列数 | 卡宽 | 备注 |
|---|---|---|---|---|
| 560–683 | 528–651 | 1 | 528–651 | 最小窗；hero 仍单行（输入框可得 400px） |
| 684–1027 | 652–995 | 2 | 320–492 | 默认 900 落此档（428px/列） |
| 1028–1371 | 996–1339 | 3 | 320–435 | |
| ≥1372 | ≥1340 | 4 | 320– | 上限 4 列，避免长行难扫读 |

抽屉打开时覆盖右侧 392px；1–2 列档位下卡片被覆盖属预期（有 scrim 提示）。

---

## 2. Design Tokens

变量组织：`:root` 放**结构 token**（间距/圆角/动效/字体/尺寸/层级），`html[data-theme='dark']` 与 `html[data-theme='light']` 放**色彩 token**，两主题 token 名 100% 对齐。组件规则内**禁止写死 hex**（例外：`rgba(255,255,255,...)` 高光与 `rgba(0,0,0,...)` 阴影）。

### 2.1 背景层级

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `--bg-app` | `#0b0e14` | `#eef2f8` | 应用最底层（滚动区露出的底色） |
| `--bg-chrome` | `rgba(16,20,29,.86)` | `rgba(255,255,255,.88)` | 顶栏 / 状态栏 / 抽屉（配 `backdrop-filter`） |
| `--bg-card` | `#131822` | `#ffffff` | 卡片、抽屉内浮层表面 |
| `--bg-well` | `#0e121a` | `#f5f8fc` | 输入框 / 分段控件 / 模板输入（凹陷井） |
| `--bg-hover` | `#1a2130` | `#eef2f8` | 行 hover、幽灵按钮 hover、chip 底 |
| `--bg-active` | `#222b3c` | `#e4eaf3` | 按下态底 |

### 2.2 描边与高光

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `--border-subtle` | `#1c2331` | `#eaeef5` | 卡内行/表格分隔 |
| `--border` | `#273044` | `#dde3ed` | 输入框、分段控件、卡默认描边 |
| `--border-strong` | `#364159` | `#cbd4e2` | hover 强化边框、滚动条拇指 |
| `--hairline-top` | `inset 0 1px 0 rgba(255,255,255,.05)` | `inset 0 1px 0 rgba(255,255,255,.9)` | 表面顶部 1px 高光（玻璃感来源） |

### 2.3 文字层级（对比度已按 WCAG AA 核对，括号内为对各自底色的实测比值）

| Token | Dark | 对比度 | Light | 对比度 | 用途 |
|---|---|---|---|---|---|
| `--fg` | `#e8eef7` | 14.9:1（卡底） | `#121a26` | 17.5:1（白底） | 正文、标题、值块 |
| `--fg-muted` | `#9aa7be` | 7.2:1 | `#5b6678` | 5.8:1 | 卡标题、行标签、说明 |
| `--fg-faint` | `#7f8ba1` | 5.1:1 | `#616b7c` | 4.9:1（白）/4.8:1（app 底） | 状态栏、placeholder、hint、表头 |
| `--fg-mono` | `#d8e7f8` | 13.9:1 | `#0f1b2a` | 17.4:1 | 等宽数值主色（重点核对项） |
| `--fg-disabled` | 同 `--fg-faint` + `opacity:.45` | — | 同左 | — | 预留禁用态 |

字号/行高/字重阶梯（结构 token）：

| Token | 值 | 用在哪 |
|---|---|---|
| `--fs-xs` / `--lh-xs` | 11px / 16px | 徽标、状态栏、表头、卡 note |
| `--fs-sm` / `--lh-sm` | 12px / 18px | 卡标题、help 表格、note 块 |
| `--fs-base` / `--lh-base` | 13px / 20px | chip、ghost 按钮、帮助正文 |
| `--fs-md` / `--lh-md` | 14px / 22px | 卡值、行值（mono） |
| `--fs-lg` / `--lh-lg` | 19px / 26px | 主输入（mono） |
| `--fs-xl` | 15px / 20px | brand、抽屉 h2 |

字重：400 正文 / 500 数值与按钮 / 600 标题与强调 / 700 徽标。
字距：mono 数值 `letter-spacing .2px` + `font-variant-numeric: tabular-nums`（保证 10/13/16/19 位数字各列右缘不抖）；卡标题 `.4px`；抽屉小标题 `.8px`。
字体栈：`--font-sans: system-ui, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif`；`--font-mono: ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace`（零网络，中文自动回落系统 CJK）。

### 2.4 间距 / 圆角 / 层级

| 类别 | 值 |
|---|---|
| 间距刻度 | `--sp-1:4` `--sp-2:6` `--sp-3:8` `--sp-4:12` `--sp-5:16` `--sp-6:20` `--sp-7:24` `--sp-8:32`（4px 基准） |
| 圆角 | `--r-xs:6`（行内图标按钮）`--r-sm:8`（chip/输入框/值块）`--r-md:10`（主输入/分段控件）`--r-lg:14`（卡片）`--r-xl:16`（抽屉/浮层）`--r-pill:999`（徽标/胶囊） |
| 层级 | `--z-scrim:40` `--z-drawer:50` `--z-toast:60` |
| 固定尺寸 | `--h-top:50` `--h-status:28` `--h-input:44` `--h-seg:34` `--h-act:22` `--w-drawer:392` |

### 2.5 强调与语义色

| Token | Dark | Light | 说明 |
|---|---|---|---|
| `--accent`（填充） | `#35d3a1` | `#10a97a` | 分段 active 底、焦点边框色源 |
| `--accent-text`（表面文字） | `#35d3a1`（9.2:1） | `#0a7a5c`（5.3:1） | 徽标文字、抽屉小标题、token 列、hover 值 |
| `--accent-contrast` | `#06170f`（9.7:1 on accent） | `#04231a`（5.5:1 on accent） | 落在 accent 填充上的文字（"本地/UTC"） |
| `--accent-wash` | `rgba(53,211,161,.10)` | `rgba(16,169,122,.08)` | hover 底色 |
| `--accent-soft` | `rgba(53,211,161,.16)` | `rgba(16,169,122,.13)` | 徽标/chip 底 |
| `--accent-line` | `rgba(53,211,161,.42)` | `rgba(10,122,92,.34)` | hover 边框、可点值左条 |
| `--accent-ring` | `rgba(53,211,161,.22)` | `rgba(16,169,122,.18)` | 焦点光晕 |
| `--amber` | `#f0b45f`（9.3:1） | `#9d6109`（5.1:1） | 原始精度、现在、边界说明 |
| `--amber-wash` / `--amber-soft` | `rgba(240,180,95,.10)` / `.16` | `rgba(157,97,9,.08)` / `.12` | 同上底色层级 |
| `--amber-line` | `rgba(240,180,95,.40)` | `rgba(157,97,9,.30)` | 原始行左条、note 边框 |
| `--danger` | `#ff7b72`（7.0:1） | `#c2333a`（5.5:1） | 错误消息、错误码 |
| `--danger-wash` / `--danger-soft` | `rgba(255,123,114,.09)` / `.15` | `rgba(194,51,58,.06)` / `.10` | 错误框底、按下底 |
| `--danger-line` | `rgba(255,123,114,.42)` | `rgba(194,51,58,.34)` | 错误框边框 |
| `--ok` | 同 `--accent-text` | 同 `--accent-text` | 复制成功对勾 |

> `--accent-wash/soft/line/ring` 允许用 `color-mix(in srgb, var(--accent) 10%, transparent)` 派生以少写 8 个 rgba（需 WebView2 ≥ Chrome 111）；若保守，直接用上表显式 rgba。

### 2.6 阴影 / 玻璃 / 动效

| Token | Dark | Light |
|---|---|---|
| `--shadow-1` | `0 1px 2px rgba(0,0,0,.45)` | `0 1px 2px rgba(16,24,40,.07), 0 1px 3px rgba(16,24,40,.05)` |
| `--shadow-2`（卡 hover） | `0 8px 24px -10px rgba(0,0,0,.65)` | `0 10px 26px -12px rgba(16,24,40,.20)` |
| `--shadow-pop`（toast/抽屉） | `0 18px 46px -18px rgba(0,0,0,.75)` | `0 18px 40px -18px rgba(16,24,40,.24)` |
| 玻璃模糊 | `backdrop-filter: blur(16px) saturate(1.25)` | `backdrop-filter: blur(16px)` |
| `--scrim` | `rgba(3,6,12,.55)` | `rgba(15,23,42,.26)`（+`blur(2px)`） |

动效 token：`--dur-1:90ms`（按压）`--dur-2:150ms`（hover/颜色）`--dur-3:220ms`（内容刷新/错误）`--dur-4:190ms`（抽屉关闭）`--dur-5:340ms`（抽屉打开）；
缓动：`--ease-out:cubic-bezier(.22,1,.36,1)` `--ease-in:cubic-bezier(.4,0,1,1)` `--ease-io:cubic-bezier(.4,0,.2,1)` `--ease-pop:cubic-bezier(.34,1.4,.64,1)`。

---

## 3. 组件视觉契约

### 3.0 图标系统（内联 SVG，零图标库）

一律 24×24 viewBox、`fill:none`、`stroke` 不透明、`stroke-width:2`、圆头圆角，**以 CSS `mask-image`(data URI) 渲染在 `::before` 上**，按钮本体 `font-size:0` + 固定尺寸隐藏原字形。这样 JS 动态生成的 `.row-copy` 与静态按钮共用一套图，**零 HTML/JS 改动**。

| 图标 | 元素 | 尺寸 | 用在 |
|---|---|---|---|
| 复制 | `<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>` | 14px | `.act[data-copy]::before`、`.row-copy::before` |
| 回填 | `<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>` | 14px | `.act[data-use]::before` |
| 太阳 | `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>` | 15px | `html[data-theme='dark'] #btn-theme::before` |
| 月亮 | `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>` | 15px | `html[data-theme='light'] #btn-theme::before` |
| 对勾（可选） | `<path d="M20 6 9 17l-5-5"/>` | 14px | `.act.copied::before`、`.row-copy.copied::before`（P1 增强） |

data URI 需转义 `<` `>` `#` `"`；同时给 `-webkit-mask-image` 前缀。文字按钮（现在/清空/帮助/关闭）**不加图标**，保持中文标签的干净读感。

### 3.1 顶栏 `.top`

结构：`高度 50px`｜`padding 0 16px`｜`bg-chrome + blur`｜底边 `1px --border-subtle`｜左 brand（图标 18px `fill:--accent-text` + 15px/600 文字，间距 8）｜右 tools（间距 6，`margin-left:auto`）。

| 状态 | `.ghost-btn`（现在/清空/帮助，28px 高，`padding 0 10`，圆角 8，12px/500） |
|---|---|
| default | 透明底、无边框、`--fg-muted` |
| hover | 底 `--bg-hover`、文字 `--fg`、边框透明（150ms） |
| active | `scale(.97)`（90ms）、底 `--bg-active` |
| focus-visible | `outline 2px --accent-ring` + `outline-offset 1px` |
| disabled | `--fg-disabled`、`cursor:not-allowed`（预留） |

分组：`现在 清空` ｜1px 竖向分隔（14px 高 `--border`）｜ `帮助` ｜ `[主题图标按钮]`。
`#btn-theme`：28×28、圆角 8、`font-size:0`；hover 同 ghost；active `scale(.92)` + 图标旋转 90°（150ms `--ease-pop`）。

### 3.2 主输入条 `#input` + `.zoneswitch`

`#input`：高 44｜`padding 0 14`｜圆角 `--r-md`｜底 `--bg-well`｜边框 1px `--border`｜`font-mono 19px/26 tabular`｜`caret-color:--accent-text`｜`::selection` 底 `rgba(accent,.28)`。

| 状态 | 差异 |
|---|---|
| default | 边框 `--border`，无光晕 |
| hover | 边框 `--border-strong`（150ms） |
| focus | 边框 `--accent` + `box-shadow 0 0 0 3px --accent-ring`（150ms `--ease-out`） |
| error（可选增强） | 边框 `--danger-line`；仅在错误框出现且输入非空时叠加，避免"边打字边红" |
| placeholder | `font-mono 13px`、`--fg-faint`（中文回落系统 CJK 字体，视觉与 sans 一致） |

`.zoneswitch`（分段控件）：外框 高 34｜内 `padding 2`｜圆角 `--r-md`｜底 `--bg-well`｜边框 1px `--border`｜**不用 `overflow:hidden`**（否则焦点环被裁），由两个子按钮各自圆角 8 承担。

| `.zone-btn`（min-width 52px、高 30、12.5px/600、间距 2） | default | hover | active（`.active`） | focus-visible |
|---|---|---|---|---|
| 底 | 透明 | `--bg-hover` | `--accent` + `--hairline-top` + `--shadow-1` | 同左列 |
| 文字 | `--fg-muted` | `--fg` | `--accent-contrast` | — |
| 附加 | — | — | 切换时 140ms 交叉淡入（不做滑块位移，因容器无状态类） | `outline 2px --accent-ring, offset -2px` |

### 3.3 识别徽标 `#kind.badge`（`.hero-sub` 内，行高 20 + 上距 8）

胶囊：`padding 2px 10px`｜圆角 `--r-pill`｜12px/600｜底 `--accent-soft`｜文字 `--accent-text`｜前置 5px 圆点（`--accent-text`，带 `0 0 6px` 同色微光）。
`.badge.stale`（错误态文案"无法识别"）：底 `--bg-hover`、文字 `--fg-muted`、圆点 `--amber`、1px 虚线 `--amber-line`。
可见性依赖 §0 的 `[hidden]` 修复。

### 3.4 空闲引导 `.idle`

居中；提示语 13px/20 `--fg-muted`（字距 .2）；chips 容器 `max-width 620px; margin 0 auto; gap 8; flex-wrap`；`.idle::before` 可选一枚 64px 品牌时钟水印（data URI mask，`--accent` 8% 透明度）置于文字上方 16px，提升"有辨识度"但不喧宾夺主。

`.chip`：高 28｜`padding 0 12`｜圆角 `--r-pill`｜底 `--bg-card`｜边框 1px `--border-subtle`｜`font-mono 12.5px/16`｜文字 `--fg`。

| 状态 | 差异 |
|---|---|
| hover | 边框 `--accent-line`、底 `--accent-wash`、文字 `--accent-text`、`translateY(-1px)`、`--shadow-1`（150ms） |
| active | `scale(.96)`（90ms） |
| focus-visible | `outline 2px --accent-ring`（offset 2） |

### 3.5 错误框 `#error.errbox`

网格两列 `[20px 图标][1fr 内容]`，`padding 11px 14px`，圆角 12，底 `--danger-wash`，边框 1px `--danger-line`，左边框 3px `--danger`（错误框的"信号条"）。
图标：`::before` 20px 圆 + `--danger-soft` 底 + `--danger` "!" 字形（纯 CSS，无 DOM 改动）。

| 元素 | 规格 |
|---|---|
| `#error-msg` | 13.5px/20、600、`--danger`（7.0:1 / 5.5:1） |
| `#error-code`（**新增 DOM**） | mono 10.5px/16、700、字距 .6、`padding 1px 6px`、圆角 6、底 `--danger-soft`、边框 1px `--danger-line`、文字 `--danger`；空值时 `:empty{display:none}` 自动收口 |
| `#error-hint` | 12px/18、`--fg-faint`、上距 6 |

出现顺序建议：`错误码徽标 → 消息 → 建议`，同框内不做逐条动画，整体一次性入场（见 M3）。

### 3.6 输出卡片 `.card`

骨架：`radius 14`｜`padding 12px 14px 13px`｜底 `--bg-card`｜边框 1px `--border-subtle`｜`--shadow-1` + `--hairline-top`。

| 状态 | 差异 |
|---|---|
| default | 如上 |
| hover | `translateY(-1px)`、边框 `--border`、`--shadow-2`（180ms `--ease-out`） |
| focus-within | 边框 `--accent-line` + `0 0 0 2px --accent-ring`（键盘可达时卡头按钮整体显形） |
| 主卡（`.cards > .card:first-child` = Unix 卡） | 顶部 `inset 0 2px 0` 青碧渐变条 + 标题用 `--fg`；其余卡标题 `--fg-muted` |

卡头（高 24，下距 6）：标题 12px/600 字距 .4；`.card-note` 11px `--fg-faint`、`max-width 45%`、单行省略；`#n-unix`（输入精度）改 `--amber` 呼应原始行；`#n-iso-local`（时区名）用 mono 10.5px `--fg-faint`。
`.card-acts`：`margin-left:auto`、间距 4、**默认 `opacity .4`，卡 hover / focus-within → 1**（140ms）；`.cards.stale` 下锁定 `.25` 且不响应 hover。

`.act` / `.row-copy` 图标按钮：

| 尺寸 | default | hover | active | focus-visible |
|---|---|---|---|---|
| `.act` 22×22（圆角 6，图标 14） | `--fg-muted` | 底 `--accent-soft`、图标 `--accent-text`、`scale(1.06)` | `scale(.92)`（90ms） | `outline 2px --accent-ring` |
| `.row-copy` 20×20（圆角 6，图标 12） | `opacity 0` | 行 hover 或按钮 `:focus-visible` → `opacity 1` + 同 `.act` hover 配色 | 同左 | 同左 |

### 3.7 值块（可复制 / 可回填）

`.card-value`：`padding 7px 9px`｜圆角 8｜mono 14px/22 tabular（非 mono 卡 14px/22 `--fg`）｜`cursor:pointer`｜`overflow-wrap:anywhere`｜`min-height 34`。

| 状态 | 差异 |
|---|---|
| hover | 底 `--accent-wash`、文字 `--accent-text`、**左侧 2px `--accent` 竖条**（`::before` 绝对定位，`inset-block 6px`）——这是"可点回填"的核心识别符 |
| active | 底 `--accent-soft` |
| focus-visible | `outline 2px --accent-ring`（若未来加 tabindex） |
| 禁用 | `#v-calendar` 特判：`cursor:default`、无 hover 底色与竖条（引擎无回填语义） |

`.row-value`（Unix 四行 / 世界时钟）：`flex:1`、mono 13.5px/20 tabular、`cursor:pointer`；hover 时文字 `--accent-text` + 左条（不叠底，底由整行负责）。

### 3.8 Unix 四行 `.rows` 与世界时钟 `.rows`

`.row`：高 27｜`padding 0 6`｜圆角 7｜间距 0（无分隔线，靠列对齐扫读）；hover 底 `--bg-hover`（150ms）；`.row-label` 定宽 44px、12px `--fg-muted`。

`.row-origin`（原始精度行）：
- 行底 `--amber-wash`、左侧 2px `--amber` 竖条；
- `.row-label::after` 的 `·原始` 做成迷你徽标：10px/600、`--amber`、底 `--amber-soft`、圆角 4、`padding 0 4px`、左距 4（内容文案不变，仍是 `·原始`）；
- 该行的值 flash 用琥珀色（见 M1）。

**世界时钟行**：`.row-label.wc-label` 单独定宽 `width: clamp(88px, 27%, 124px)`、mono 11.5px、`white-space:nowrap; overflow:hidden; text-overflow:ellipsis`；行高 27；值 mono 13.5；每行 `⧉` 与值点击行为不变（`America/New_York` 16 字符在 124px 内可完整显示，560 窄窗下退化为省略号而不挤压数值）。

### 3.9 模板卡（`.card:nth-child(10)`）

`#tpl-in`：高 30｜`padding 0 9`｜圆角 8｜底 `--bg-well`｜边框 1px `--border`｜mono 13px；focus：边框 `--accent` + `0 0 0 2px --accent-ring`；下距 8。
`#tpl-out`：`padding 8px 10px`｜圆角 8｜底 `--bg-well`｜mono 14px/22 tabular；hover 同 `.card-value`（wash + 左条 + accent 文字）。
`#tpl-err`：12px/18 `--danger`，前置 6px `--danger` 圆点（`::before`），上距 6。

### 3.10 帮助抽屉 `#help` + `.overlay`

遮罩 `.overlay`：`--scrim` + `blur(2px)`；`z-index:40`。
面板：**浮动式**——`inset: 10px 10px 10px auto`（上右下 10px 内缩）、宽 `clamp(320px, 44vw, 420px)`（默认取 392）、高 `calc(100% - 20px)`、圆角 `--r-xl` 16、底 `--bg-chrome` + `blur(16px) saturate(1.25)`、边框 1px `--border`、`--shadow-pop`、内滚 `overscroll-behavior:contain`；`padding 18px 18px 24px`。

结构规格：

| 元素 | 规格 |
|---|---|
| `.close-row` + `#help-close` | 右上；ghost 按钮（同 §3.1），文案"关闭"不改 |
| `h2` | 15px/20、600、`--fg` |
| `.sub` | 12px/18、`--fg-faint` |
| `h3` | 11.5px/16、700、字距 .8、`--accent-text`、上距 18 下距 8；`::before` 3×12px 圆角竖条 `--accent` |
| `.help-table` | 12px/18；`td padding 5px 8px`；行间 1px `--border-subtle`；行 hover 底 `--bg-hover`；首列（`.tok`）mono 11.5px/600 `--accent-text` nowrap；`.ex` 列 mono `--fg-muted`；描述列 `--fg-muted` 允许换行 |
| `.note` | 底 `--amber-wash`、左边框 2px `--amber`、圆角 10、`padding 9px 11px`、12px/19、`--fg` |

### 3.11 Toast `#toast`

`bottom 44px`（状态栏 28 + 16 留白）｜居中｜`padding 8px 14px`｜圆角 10｜底 deep 浮层色（dark `#1e2635` / light `#101828`）｜文字（dark `#eef3fa` / light `#f6f8fc`）12.5px/18｜`--shadow-pop`｜`z-index:60`｜`max-width 70%`｜单行省略。
可选增强：左侧 3px `--accent` 竖条表示"成功"、`--danger` 表示失败（需 1 行 JS，见 §6）。

### 3.12 状态栏 `.status`

高 28｜`padding 0 16`｜底 `--bg-chrome` + blur｜上边框 1px `--border-subtle`｜11.5px/16 `--fg-faint`｜单行省略。
前置 6px 状态点（`::before`，`:has()` 驱动，零 JS）：空闲 = `--fg-faint` 45%；结果态（`body:has(#cards:not([hidden]))`）= `--accent-text`；错误态（`body:has(#error:not([hidden]))`）= `--danger`（此规则写在最后以覆盖前一条）。不支持 `:has()` 时自然降级为无点。

### 3.13 滚动条

`::-webkit-scrollbar` 宽/高 8｜track 透明｜thumb `--border-strong`（默认为 `--border`）圆角 `--r-pill`；`.stage` 与 `.drawer` 同规格。

---

## 4. 微交互与动效契约

| 编号 | 触发 | 表现 | 时长 / 缓动 |
|---|---|---|---|
| **M1** 值刷新 | 输入去抖 120ms（app.js 固定）后值文本发生变化 | 值节点加 `.flash`：`box-shadow: inset 0 0 0 999px var(--accent-wash)` 渐隐到透明（inset 阴影覆盖底色层、不参与排版，因此与 hover 底色不打架）；`.row-origin` 内改用 `--amber-wash`；**文本未变化的节点不动**，避免连续输入时满屏闪 | 260ms `--ease-out`，无位移 |
| **M2** 卡片入场 | `.cards` 从 `hidden` 变为可见（空闲→结果、首次解析） | 每卡 `opacity 0→1` + `translateY(6px)→0`；用 `nth-child(1..10)` 给 0/18/36/…/162ms 阶梯延迟（纯 CSS，无 JS） | 单卡 300ms `--ease-out`，总 ≤470ms |
| **M3** 错误出现 | `#error` 由 `hidden` 变可见 | `opacity 0→1` + `translateY(-4px)→0`，无 scale（错误不该"弹"） | 220ms `--ease-out` |
| **M4** 陈旧降噪 | `.cards.stale` 加/去 | `opacity 1↔.55`（用 opacity，不用 `filter: saturate()`，避免 10 卡同时建合成层）；边框与文字色同步降噪保持 `.stale` 内不播放 M1 闪动 | 进入 180ms / 恢复 220ms，`--ease-io` |
| **M5** 值回填 | 点击任意可点值 / 卡头"回填"按钮 | 依赖 `#input` 的 `:focus` 过渡（点击使输入框失焦再获焦 → 边框与光环 150ms 淡入）+ M1 值闪动作为"数据已换源"的主反馈；**不额外加动画**。可选 P2：输入框播放一次 240ms 的光环收束（6px→3px） | 150ms / 240ms `--ease-pop` |
| **M6** 复制反馈 | 点击 `.act[data-copy]` / `.row-copy` | 按钮 `:active scale(.92)`（90ms）；成功后（可选 P1）图标换为对勾 + `--accent-text`，900ms 后复原；toast 上浮入场 | 90ms / 900ms / 入场 160ms `--ease-out`，出场 200ms `--ease-in` |
| **M7** 抽屉进出 | 帮助/关闭/点遮罩/Esc | 开：scrim `opacity 0→1` 200ms + 面板 `translateX(100%)→0` 与 `scale(.995)→1`；关：scrim 160ms + 面板 190ms——**关闭必须 ≤ app.js 的 200ms `hidden` 计时**，用"关闭态定义 190ms、`.open` 态定义 340ms"的双向时长技巧实现 | 开 340ms `--ease-out`；关 190ms `--ease-in` |
| **M8** 主题切换 | 主题按钮 | 表面色（背景/边框）200ms `--ease-io`、文字 150ms；不写 `*{}` 过渡，只在 `.top/.hero/#input/.zone-btn/.chip/.card/.row/.act/.status/.badge/.drawer/.overlay/.toast` 白名单上挂 `background-color,border-color,color,box-shadow` | 200ms / 150ms |
| **M9** chip / 行 hover | 指针进入 | chip `translateY(-1px)`；卡片 `translateY(-1px)` + 阴影 1→2；行底色淡入；`.row-copy` `opacity 0→1` | 150ms / 180ms / 140ms |
| **M10** 布局重排 | 窗口缩放跨断点 | 不做列动画（拖动窗口时动画只会拖后腿），仅保留卡片阴影/边框过渡 | — |
| **M11** 降级 | `prefers-reduced-motion: reduce` | 全部 `animation/transition` 归零（保留 opacity 瞬时切换），禁用所有 transform 动画 | 0ms |

---

## 5. 主题切换机制

1. **变量组织**：`:root` = 结构 token；`html[data-theme='dark']`、`html[data-theme='light']` = 色彩 token，两组键名逐一对应（可用脚本 diff 键名做 CI 检查）。`data-theme` 保持在 `<html>` 上（app.js 现有行为，勿改到 body）。
2. **原生控件同步**：在各主题块内声明 `color-scheme: dark` / `color-scheme: light`，让输入框光标、选区、原生滚动条与主题一致（`<meta name="color-scheme">` 保持现状即可）。
3. **切换过渡**：按 M8；图标切换由 `html[data-theme='dark'] #btn-theme::before` 选择器决定，天然同步，无需 JS。
4. **首帧闪烁（已知风险，P2）**：`spark.db` 读取是异步的，浅色偏好用户启动时会有约 1 帧暗底。可选缓解：在 `index.html` 的 `<head>` 内加 2 行仅读 `localStorage('tc-prefs')` 预设 `data-theme` 的内联脚本（不违反"零网络"，但属内联脚本、需 owner 认可）；不做则接受 1 帧暗闪，其余逻辑不变。

---

## 6. DOM 最小改动清单与实现风险

### 6.1 必改（1 处 DOM + 2 行 JS）

| 位置 | 改动 | 说明 |
|---|---|---|
| `index.html` `.errbox` 内 | 新增 `<span id="error-code" class="err-code"></span>` | 承载错误码徽标；空值由 `:empty{display:none}` 收口，即使 JS 未接也不破版 |
| `app.js` `renderError` | 2 行：写入 `error.code` 文本 / 空时清空 | UI 层，不涉日期算法 |

### 6.2 可选增强（每条独立可裁剪，均为 UI 层小改）

| 编号 | 改动 | 收益 |
|---|---|---|
| P1 | `copyText(v)` 增加按钮参数，成功回调给该按钮加 `.copied`（900ms 后移除） | 行内复制对勾反馈 |
| P1 | `fillCards` 末尾：仅对文本发生变化的节点 toggle `.flash`（强制重排重启动画） | 启用 M1 值闪动 |
| P2 | `useAsInput` 给 `#input` 加 `.pulse`（240ms 后移除） | 回填时的输入框光晕收束 |
| P2 | `toast(msg, isErr)` 加 `.err` 类 | toast 语义竖条 |
| P2 | `applyTheme` 给 `<html>` 加 `.theming`（切换期间禁过渡，200ms 后移除） | 消除个别元素过渡不同步的拖影 |

### 6.3 实现风险提示（按优先级）

1. **`[hidden]` 覆盖问题**（P0）：不加 `[hidden]{display:none !important}`，空闲态会显示 10 张空卡 + 空徽标；这是"改完样式突然多出一堆空框"的最可能原因，务必先改。
2. **`.wc-label` 溢出**（P0）：保持 40px 定宽会让 `America/New_York` 把数值挤出卡外，必须按 §3.8 单独定宽。
3. **mask 图标兼容**（P1）：`mask-image` 需 `-webkit-` 前缀；WebView2 过旧时按钮会变成空白——用 `@supports (mask-image: url(''))` 包裹，不支持时回退为保留原字形（`font-size` 不置 0）。
4. **抽屉关闭时长耦合**（P1）：关闭动画 >200ms 会被 app.js 的 `hidden` 计时截断，必须按 M7 的双向时长写法。
5. **flash 与 hover 底冲突**（P1）：flash 用 inset box-shadow 而不是 `background-color`，否则会把 hover 底色冲掉。
6. **stale 用 filter 的代价**（P2）：10 卡同时 `saturate()` 在低端机可能掉帧，蓝图已改为 opacity 方案，勿回退。
7. **`overflow-anchor`**（P2）：值变长（如 10 位→19 位）时浏览器滚动锚定会让 stage 跳动，`.stage{overflow-anchor:none}`。
8. **滚动条出现挤宽**（P2）：`scrollbar-gutter: stable`，否则空闲→结果时卡片宽度会跳 8px。
9. **`:has()` 状态点**（P3）：Chrome 105+ 才支持；不支持时静默降级，功能不受影响。
10. **文件形态**（P0，AGENTS.md）：`style.css` 会被大幅扩写（预计 700–850 行）但仍单文件；**不得**新增内联 `<style>`/`<script>`，不得引入字体或图标库，页面加固段保持原样。

---

## 7. 验收清单（实现后逐条核对）

**结构与形态**
1. `git status --short time-converter/0.1.0/` 干净；`node --check app.js` 通过；无新增内联 style/script；未触碰 `engine.js`。
2. DevTools 里确认 `[hidden]{display:none}` 生效：空闲态无空卡片、无空徽标。

**Token 落地（抽样 12 项，明暗各查一遍）**
3. 计算值等于蓝图：`--bg-card` / `--fg-mono` / `--accent` / `--accent-contrast` / `--shadow-1` / `--r-lg` / `--h-top` / `--fs-md` / `--dur-5` / `--ease-out` / `--scrim` / `--amber`。
4. 组件规则内无散落 hex（grep `#[0-9a-f]{6}` 只应出现在 token 块与高光/阴影 rgba 中）。

**对比度（每主题 6 组）**
5. 用 DevTools 对比度工具核对：正文对卡底、`--fg-mono` 对卡底、`--fg-faint` 对状态栏底、`--accent-text` 对卡底、`--accent-contrast` 对 `--accent`、`--danger` 对错误框底——全部 ≥4.5:1（正文/数值）与 ≥3:1（纯装饰元素）。

**尺寸与栅格**
6. 顶栏 50 / 状态栏 28 / 主输入 44 / 分段控件 34 / `.act` 22 / 卡值块 ≥34 / 行 27 / 卡圆角 14 / 抽屉宽 392（窗口 900 时）。
7. 窗口依次调到 560 / 700 / 900 / 1100 / 1400：列数为 1 / 2 / 2 / 3 / 4；560 宽下 `#input` 仍单行且 ≥380px。

**状态枚举（截图对照）**
8. 每个交互元素在 default / hover / active / focus-visible 下与 §3 表格一致：ghost、zone-btn（含 `.active`）、chip、`.act`、`.row-copy`（含隐藏→显形）、`.card-value`、`#tpl-in`、`#help-close`。
9. 键盘 Tab 全走查：焦点环在深/浅底上均可见、不被 `overflow` 裁剪（尤其分段控件）。
10. 六类错误码逐个触发（`UNRECOGNIZED` / `AMBIGUOUS` / `INVALID_FIELDS` / `OUT_OF_RANGE` / `BAD_TOKEN` / `EMPTY`），错误框徽标文案与状态栏 `错误 CODE` 一致；此时卡片为 stale 降噪且无 hover 上浮。
11. 世界时钟 6 行在 560 宽下不横向溢出，`America/New_York` 完整或省略号；19 位纳秒戳在 1 列卡内正常换行不撑破。

**动效**
12. DevTools Animations 面板核对：值刷新 260ms、卡入场 300ms+阶梯、错误 220ms、抽屉开 340ms / 关 190ms、toast 160/200ms；关闭抽屉时无"半开截断"。
13. 复制一次：按钮按压 + toast 上浮；若启用 P1，对勾 900ms 后复原。
14. 连续快速输入（每 60ms 一个字符）：无满屏闪烁、无滚动跳动、无卡片重排抖动。
15. 系统开启"减少动态效果"后：无 transform 动画、无入场位移。

**主题**
16. 切换主题时顶栏/卡/抽屉/状态栏同步过渡 200ms，无单元素滞后；主题切换后立即重开窗口，偏好被记住且首帧不出现明显白闪（或已按 §5.4 处理）。

---

## 8. 相对现状的变更点汇总（给实现者的一页速览）

1. Accent 绿 → 青碧（`#10a97a` / `#35d3a1`），accent 拆成"填充 / 表面文字 / 填充上文字"三个 token。
2. 卡片圆角 10 → 14，卡 padding 增大到 12/14/13，卡 hover 上浮 1px + 阴影加深。
3. 幽灵按钮去边框化；纯图标按钮（复制/回填/主题）改为 mask 内联 SVG，按钮本体 `font-size:0`。
4. 卡值 hover 增加左侧 2px 竖条作为"可回填"识别符；`#v-calendar` 明确禁用该交互。
5. 卡片头操作按钮默认 40% 可见（原 0），行复制仍保持 0 → 1。
6. 错误框增加错误码徽标、左侧 3px 信号条、CSS 绘制的感叹号；错误态卡片降噪由 `filter` 改为 `opacity`。
7. 帮助抽屉改为浮动面板（内缩 10px、圆角 16、玻璃模糊），保留原进出场语义。
8. 修三处现存缺陷：`[hidden]` 覆盖、世界时钟标签宽度、滚动条挤宽与滚动锚定。
9. 新增动效契约：值闪动、卡片阶梯入场、抽屉双向时长；全部受 `prefers-reduced-motion` 兜底。

**涉及文件（实现时）**
`D:\demo\test01\spark-plugins\time-converter\0.1.0\style.css`（主要落点）
`D:\demo\test01\spark-plugins\time-converter\0.1.0\index.html`（仅错误码徽标 1 个 span）
`D:\demo\test01\spark-plugins\time-converter\0.1.0\app.js`（仅可选 P1/P2 的 UI 挂钩，禁止日期算法）