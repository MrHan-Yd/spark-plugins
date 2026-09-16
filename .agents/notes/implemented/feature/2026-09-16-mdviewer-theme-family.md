# Agent Note: Markdown 查看器视觉家族延续与主题策略
Status: implemented
Class: feature

## 背景
UI 设计师蓝图与仓库既有插件（code-calc/local-search 的暖纸底+琥珀 token 族、trace-board 的冷蓝族）并存，新阅读器要不要新立视觉一族、主题跟随策略怎么定，需要拍板。

## 决策
1. **延续 code-calc 的 token 族**（`--bg #0b0e13 / --accent #f2a04b` 暗色、`#f5f2ec / #c26f1d` 亮色，圆角 8/10/14、28px 按钮、10px 滚动条全套照搬），在其上**扩充阅读场景 token**：`--code-bg`（代码块更沉）、`--inline-code`、`--link`、`--zebra`（表格斑马纹）。理由：仓库多数插件同族，暖纸底对长文阅读友好，琥珀在两主题下对比度均达标。
2. **主题策略**：双主题 + 初始跟随 `prefers-color-scheme`（首次无记录时），之后以用户手动切换为准存 `spark.db`（键 `theme`）。宿主没有主题 API（文档 §6 全表核对）。
3. **muted 色 light 主题加深**（`#8f8677` → `#6f675a`）：家族原值在 light 底上仅 3.2:1，不过 WCAG AA；加深后 5.0:1 达标（AA）。这是对家族 token 的唯一修订，code-calc 未跟进（其状态栏 11.5px 文字同样受影响，属历史债，不在本插件范围内修）。
4. 正文链接 light 主题用专用 `--link #8a4a0f`（6.7:1）而不用 accent `#c26f1d`（3.4:1，仅够大字/UI 组件）。

## 放弃方案
- 新立冷蓝一族（最强理由：阅读器用冷色更「工具感」）。仍然不用：一家一族会让仓库色板碎片化；暖纸底长文阅读更舒适。
- 固定单主题（最强理由：省一半 token 与切换代码）。仍然不用：dark-only 查看器在白天刺眼，light-only 在夜里晃眼，成本只是两段 CSS 变量。

## 代价与后果
- `--muted` 的 light 值与 code-calc 家族出现分叉（有意的修订，理由如上；若家族统一跟进可直接抄 `#6f675a`）；
- `prefers-reduced-motion` 沿用家族全局关动画规则。