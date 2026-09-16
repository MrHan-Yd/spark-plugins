# Agent Note: 追溯索引内联 diff 必须封顶
Status: implemented
Class: architecture

## 背景
index.json 会把每个会话的 diff 全部内联，供 HTTP 远程模式少发请求；但会话数 × diff 数线性增长。

## 决策
每会话内联条数封顶（DIFF_INLINE_MAX），超出只记 files.diffs 路径，看板按需回落读取；bundle 模式不受限。

## 放弃方案
完全不内联、全部按路径读取。它最省索引体积，但远程模式下每次展开 diff 都要多一次请求，弱网体验明显劣化。

## 代价与后果
索引体积上限变得可预期；代价是超出封顶的 diff 在远程模式下有额外一次往返，已用 diffs_inline_truncated 标记披露。