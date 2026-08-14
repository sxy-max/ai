# DeepSeek Reasoning-Only 失败分析（WP8，2026-08-14 实测）

## 机制（不是现象）

deepseek-v4-pro（OpenCode Go 通道）对长推理题的输出流为：

```
stream: reasoning(...) → reasoning(...) → ... → done(stopReason)
```

- reasoning 与 final 是**同一 token 预算**（max_tokens）内的两个阶段：模型先产出 reasoning tokens，剩余预算不足时被上游截断。
- 截断标志：`stopReason = "length"`（而非 "stop"）。此时 reasoning 完整、final 为空。
- 旧系统的缺陷：UI 在 `done` 事件到达即视为"已完成"（不检查 final 是否为空），且该消息作为正常 assistant 进入下一轮上下文——导致"有思考没回答"被当作成功且污染上下文。

## 实测（服务器 deepseek-v4-pro，5 次经典物理题）

| # | reasoning | final | stopReason | 判定 |
|---|-----------|-------|------------|------|
| 1 | 20501ch | 0 | length | incomplete |
| 2 | 14273ch | 0 | length | incomplete |
| 3 | 18810ch | 0 | length | incomplete |
| 4 | 5055ch | 721ch | stop | completed |
| 5 | 3330ch | 797ch | stop | completed |

结论：长推理（>5000ch reasoning）大概率吃满预算 → incomplete。短推理可正常完成。

## 修复（已落地）

1. **MessageStatus 细分**：streaming_reasoning / streaming_final / completed / incomplete / failed。
   - completed 唯一条件：final 文本非空 **或** 存在有效 Artifact。
2. **流式状态切换**：reasoning 事件 → streaming_reasoning；text 事件 → streaming_final（UI 不再"思考未结束即显示完成"）。
3. **终态判定**：finalizeStatus 在 done 时按 final/artifact 判定；incomplete/failed 显示明确提示（"模型返回了推理过程，但没有返回最终答案，请重试"）。
4. **上下文隔离**：incomplete/failed 的 assistant 消息被 sanitizeForUpstream 过滤，不进下一轮。
5. 旧存储数据归一化（normalizeMessageStatus：streaming→streaming_reasoning、complete→completed）。

## 后续优化（backlog）

- 长推理场景自动提高 max_tokens（当前 8192；deepseek 支持更高）或检测 stop='length' 后自动重试一次。
