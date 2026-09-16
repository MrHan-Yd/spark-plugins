# Agent Note: Markdown 查看器入口矩阵与 fs.read 取舍
Status: implemented
Class: architecture

## 背景
spark-plugins 新增 markdown-viewer 插件。宿主 Spark 的 `spark.fs.read` 是高危权限（首次启用弹授权 + 需在设置配置授权目录范围，范围外 `PERMISSION_SCOPE`），而纯 File API 手选文件零权限。两条打开通道摆在一起必须拍板：要不要声明 fs.read。

## 决策
入口矩阵三条 + 一条页内补充，全部落地（`plugin.json` features）：

1. keyword `md <路径>`（另有 `markdown`、`查看文档` 别名）——`spark.fs.read` 路径直开；
2. keyword 空参回车——主页空态，File API 手选文件/目录，零权限兜底；
3. regex `(?i)\.(md|markdown)$`——主输入框粘路径时追加入口，同走 fs.read；
4. 页内「打开」支持 Shift+单击选目录——目录模式是唯一能渲染相对图片、站内跳转的通道。

**声明 `fs.read`**（高危）。理由：路径直开 + regex 后缀触发是「启动器里看 md」的核心价值；不声明则这两个入口打开后全是 `PERMISSION_DENIED` 死路，入口承诺与实际能力背离。File API 手选保留为免授权通道并行存在——权限是增强不是门槛。宿主 fs.read 自带授权目录范围二次鉴权，风险有纵深。

配套铁律：任何错误态（PERMISSION_DENIED / PERMISSION_SCOPE / NOT_FOUND）都带「手选文件」按钮，永不死路。

`window.multi_instance: true`：默认 false 时再次触发只聚焦旧窗并推送新输入，但新路径与旧窗滚动位置/阅读状态的交互复杂；多开每次触发开新窗、路径隔离，行为可预期（成本：多窗口内存，可接受）。

regex pattern 若宿主正则 flavor 不支持 `(?i)` inline flag 会加载期拒载——实施时需冒烟验证，fallback 为显式大小写枚举 `[.]([mM][dD]|[mM][aA][rR][kK][dD][oO][wW][nN])$`。

## 放弃方案
零权限纯 File API（最强理由：装好即用、零授权惊吓、部分用户就是怕高危授权弹窗）。仍然不用：路径直开没了，启动器插件失去「启动器性」；且 File API 单选拿不到兄弟文件，相对图片/站内链接全渲染不了，体验上限太低——入口会骗人。

## 代价与后果
- 安装/启用时弹高危授权提示，部分用户流失（接受；subtitle 已写明用途）；
- 授权后还需配置目录范围，`PERMISSION_SCOPE` 高频出现——错误三态各配出口 + 手选兜底；
- `multi_instance: true` 多窗口内存开销（可接受）。