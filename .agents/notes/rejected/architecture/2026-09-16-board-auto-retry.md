# Agent Note: 看板侧自动重试半截索引
Status: rejected
Class: architecture

## 背景
索引重建窗口内看板可能读到半截 JSON，最初想在看板载入失败时自动重试。

## 决策
否决自动重试；改为宿主侧原子写（tmp+rename），看板侧只提示可手动重试。

## 放弃方案
看板自动重试。它最强的理由是对用户零操作；但半截文件的持续时间不可预测，盲目重试只是把错误延迟，还可能掩盖宿主崩溃。

## 代价与后果
用户在极小概率的撞窗下要多点一次「重新载入」；换来生产端一次写盘即消灭整类竞态。
替代方案落地见 [追溯索引内联 diff 必须封顶](../implemented/architecture/2026-09-16-trace-index-diff-inline-cap.md)。