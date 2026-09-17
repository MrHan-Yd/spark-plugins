# Agent Note: pdf-editor 主画布空白——渲染队列未定义引用与扫描器基建

Status: implemented
Class: bug-fix

## 背景

真机第二轮：打开成功（缩略图正常渲染，证明 vendor/pdf.js 全部工作），但**主画布全部空白**。定位为 render.js 渲染队列 pump() 调用了**从未定义的 viewportCenterIndex()**——IIFE 'use strict' 下 node --check 通过、运行时 ReferenceError、渲染循环每次泵出即抛，主画布一页未渲。缩略图走 pages.js 独立链路所以正常——这类「子链路正常掩盖主链路死亡」的故障形态极具迷惑性。

## 决策

1. **补 viewportCenterIndex 实现**（视口中心对应页序，offsetTop 精确计算），并修渲染队列三处连带竞态：rendering() 计数补 pending 标志（原只计 renderTask，getPage 挂起阶段被视为空闲 → pump 同步循环一次清空整条队列，虚拟化失效全页渲染）；renderPage 中段 st 空引用防护（等待期被 evict 时 cancel 新 task）；notifyViewport 死变量清理。
2. **建立 check-undef.mjs 静态扫描**（.zcode/pdf-editor/，dev-only）：此类缺陷 node --check 无法发现，本插件已连续五处（viewportCenterIndex / assets / ctx_PDFLib / clamp / 早期 export 半成品）。实现要点：acorn AST 手写两遍遍历（pass1 hoisting 收集 var/function/参数/catch param，pass2 沿函数作用域链查引用），跳过非计算成员属性与对象键（防误报）。**教训：acorn-walk.ancestor 不接受单函数 visitor（回调根本不触发，首版扫描器全绿是假象）——必须用探针注入验证扫描器灵敏度后再信其结果**（本版已注入 totallyMissingFn/missingVar 探针验证抓捕 ✓）。
3. 扫描抓出并修复第 5 处真缺陷：shell.js 属性面板调用了不存在的 clamp()（字号修改必炸），补纯函数。

## 放弃方案

- **依赖 dom-smoke 覆盖渲染链路**：jsdom 无 pdf.js worker，真渲染管线桩不出来——未定义引用只能靠静态分析兜底，这是 scan 脚本进 dev-only 工具链的理由。
- **acorn-walk full/ancestor 直接用**：full 不给祖先链、ancestor 单函数 visitor 不触发（实测），手写遍历虽多 60 行但行为完全可控。

## 代价与后果

- 扫描器是简化语义（var-only hoisting 近似、catch param 归宿主块）——对本仓库 var 风格足够；引入 let/const 块级作用域时需升级。
- 真机复测要点不变：主画布渲染/缩放/翻页、渲染队列虚拟化（500 页文档滚动不爆内存）。
- 留痕：本轮未过宿主（SPARK_TRACE_SESSION 空），无 @trace。

## 关联

- [[2026-09-17-pdf-editor-open-null-map]]（第一轮打开链路四缺陷，含 dom-smoke 盲区说明）
- [[2026-09-17-pdf-editor-design]]（立项总拍板）