# Harness Benchmark — Claude Code + 主模型（§31/§32）

> 真实任务 × 主模型组合验证（非 HTTP 200 冒烟）。场景 B01-B05 覆盖
> 普通中文问答 / 复杂推理 / coding / office tool use / 视觉协作。
> 运行脚本：`scripts/cloud-bench.mjs`（每模型一轮，`BENCH_MODEL` 控制）。

## 候选与角色（2026-08-17 池收敛后）

| 模型 | 角色 | 链 |
|---|---|---|
| deepseek-v4-flash | Coding / Workspace / Chat 默认（高频低成本） | agent/chat 首选 |
| deepseek-v4-pro | 高难推理 | reasoning 首选 |

## 结果（云端，tencent-ai，真实模型）

（矩阵结果填充：每模型 × 场景：成功/耗时/产物/要点）

## 结论

（填写）
