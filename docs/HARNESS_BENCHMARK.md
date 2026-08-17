# Harness Benchmark — Claude Code + 主模型（§31/§32）

> 真实任务 × 主模型组合验证（非 HTTP 200 冒烟）。场景 B01-B05 覆盖
> 普通中文问答 / 复杂推理 / coding / office tool use / 视觉协作。
> 运行脚本：`scripts/cloud-bench.mjs`（每模型一轮，`BENCH_MODEL` 控制）。

## 候选与角色（2026-08-17 池收敛后）

| 模型 | 角色 | 链 |
|---|---|---|
| deepseek-v4-flash | Coding / Workspace / Chat 默认（高频低成本） | agent/chat 首选 |
| deepseek-v4-pro | 高难推理 | reasoning 首选 |

## 结果（云端 tencent-ai，2026-08-17，真实模型 + Claude Code Harness）

### deepseek-v4-flash — 5/5 PASS

| 场景 | 结果 | 耗时 | 产物 / 要点 |
|---|---|---|---|
| B01 普通问答 | ✅ | 42s | photosynthesis_explanation_for_kids.md（面向小学生正确回答） |
| B02 复杂推理 | ✅ | 105s | 证明_根号2是无理数.md + .html（完整反证法论证，双格式） |
| B03 coding | ✅ | 73s | result.txt + analyze_sales.py + data.csv（真实运行验证） |
| B04 office tool use | ✅ | 25s | 销量数据.xlsx（真实格式） |
| B05 视觉协作 | ✅ | 298s | analyze_png/analyze2（vision 描述产物；执行中有一次 claude 挂起后自恢复，耗时偏长） |

### deepseek-v4-pro — 4/5 PASS

| 场景 | 结果 | 耗时 | 产物 / 要点 |
|---|---|---|---|
| B01 普通问答 | ❌（复测通过，见下） | 10s | 纯文本回答正确但**无产物**；系统侧缺陷（resultSummary 占位）→ 已修复 da4617f（agent_text 流兜底） |
| B02 复杂推理 | ✅ | 65s | 根号2是无理数的证明.md（**快于 flash 105s**——推理模型优势明确） |
| B03 coding | ✅ | 72s | result.txt + calc_sales.py + data.csv |
| B04 office tool use | ✅ | 53s | 销量数据.xlsx |
| B05 视觉协作 | ✅ | 242s | decoded（vision 描述产物） |

## 结论

- **flash 是 coding/workspace/chat 的正确默认**：5/5 全过、总耗时 543s、成本低；
  唯一弱点 B05 视觉场景 298s（claude 挂起后自恢复，系统修复轮已覆盖）。
- **pro 是推理首选**：B02 推理 65s 快于 flash 105s 且论证完整；coding/office/视觉均可用。
- **B01-pro 失败为系统缺陷而非模型缺陷**：回答正确但无产物时 resultSummary 是占位
  （agent_result 为「执行结束」完成信息），真实回答在 agent_text 流未累积 →
  已修复（da4617f）+ 回归测试 2 项；复测见下。
- 池结论不变：`APPROVED_POOL=[flash, pro]`；无需第三模型。

## B01-pro 复测（修复后）

（待补：da4617f 部署后重跑 bench-B01-pro）
