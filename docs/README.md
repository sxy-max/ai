# Go AI 项目认知地图（文档导航）

> 目的：读完本页 + 按序读对应文件，即可了解项目**全貌**（迭代过程、修改方向、代码架构、怎么改）。
> 用法：新接手 / 续接任务 / 调整方向时，按「一、二、三、四」顺序读；快速定位问题看「五、按需查询」。

## 一、先读这三份（10 分钟建立全貌）

| 文件 | 读完得到 | 性质 |
|---|---|---|
| [EXECUTION_STATE.md](../EXECUTION_STATE.md) | **迭代全过程**（V1.0→V1.5 每轮做了什么/验证结果/踩坑）+ **当前状态**（正在做什么/待做/Blocked/已知缺陷） | 🔴 活文档（每轮更新） |
| [DECISIONS.md](../DECISIONS.md) | **锁定决策**（不可随意推翻的技术决策——调整方向前必读） | 🔴 活文档 |
| [GO_AI_CLOUD_AGENT_ARCHITECTURE.md](../GO_AI_CLOUD_AGENT_ARCHITECTURE.md) | **总体架构**：分层（Web/Task/Sandbox/Agent/Artifact/Persistence）、十大模块、三条运行链路、十个关键问题 | 🟡 设计基线（V1.0 定稿，演进见 V15） |
| [LLM_EXECUTION_CHAIN.md](../LLM_EXECUTION_CHAIN.md) | **执行链语义**：任务怎么从用户意图走到最终产物（为什么这样拆） | 🟡 |

## 二、当前架构收敛定稿（V1.5 起，改代码前必读）

| 文件 | 内容 |
|---|---|
| [V15_HARNESS_CONVERGENCE.md](V15_HARNESS_CONVERGENCE.md) | **当前架构**：AgentScope 2.0 主 Harness + Go AI Product Layer；模块 KEEP/REPLACE 定稿；真实运行时路径图 |
| [V15_HARNESS_DUPLICATION_AUDIT.md](V15_HARNESS_DUPLICATION_AUDIT.md) | 自研模块 vs 成熟 Harness 对照表（哪些是重复实现、为什么保留） |
| [V15_HARNESS_MIGRATION_STRATEGY.md](V15_HARNESS_MIGRATION_STRATEGY.md) | 迁移路线（replace→verify→delete） |
| [V15_CLOUD 部署/矩阵工作流 → V14_CLOUD_DEPLOY_WORKFLOW.md](V14_CLOUD_DEPLOY_WORKFLOW.md) | 部署全流程 + 踩坑清单表（每条都实际踩过） |

## 三、按需：每轮迭代的审计/验收（改某块前看对应轮次）

| 想改什么 | 先读 |
|---|---|
| Agent 执行/工具 | [V13_DEEPSEEK_TOOL_PROTOCOL.md](V13_DEEPSEEK_TOOL_PROTOCOL.md)（工具调用协议实证）、[V13_RUNTIME_STATE_AUDIT.md](V13_RUNTIME_STATE_AUDIT.md)（状态机） |
| 沙盒/安全 | [V13_SECURITY_MATRIX.md](V13_SECURITY_MATRIX.md)（安全基线+实测）、[V12_SECURITY_ACCEPTANCE.md](V12_SECURITY_ACCEPTANCE.md) |
| 策略/模型选择/预算 | [V12_EXECUTION_POLICY_AUDIT.md](V12_EXECUTION_POLICY_AUDIT.md)、[V12_RUNTIME_BENCHMARK.md](V12_RUNTIME_BENCHMARK.md)（token/时间基线） |
| 视觉/图片任务 | [V11_VISION_VERIFICATION.md](V11_VISION_VERIFICATION.md)（视觉验收方法）、[DEEPSEEK_REASONING_FAILURE_ANALYSIS.md](DEEPSEEK_REASONING_FAILURE_ANALYSIS.md)（"只分析不交付"根因） |
| 能力缺口/下一步 | [V14_CAPABILITY_AUDIT.md](V14_CAPABILITY_AUDIT.md)（能力矩阵：real/partial/missing） |
| Harness 选型背景 | [V15_AGENTSCOPE_SOURCE_AUDIT.md](V15_AGENTSCOPE_SOURCE_AUDIT.md)、[V15_OPENHANDS_SOURCE_AUDIT.md](V15_OPENHANDS_SOURCE_AUDIT.md)、[V15_OPENCODE_CLAUDE_SDK_AUDIT.md](V15_OPENCODE_CLAUDE_SDK_AUDIT.md)、[RESEARCH_CLOUD_AGENT_PROJECTS.md](../RESEARCH_CLOUD_AGENT_PROJECTS.md) |

## 四、代码怎么实现（模块地图）

```
lib/
├─ taskRouter.ts       用户意图 → 任务类型/产物类型（"做 PPT"→pptx）
├─ leader/planner.ts   任务 → 步骤序列（规则/LLM）
├─ tasks/
│  ├─ worker.ts        队列/租约/心跳/恢复（控制面）
│  ├─ executionPlan.ts 执行计划（expectedArtifacts/contract/stepsTemplate）
│  ├─ executor.ts      general/research/artifact 步骤执行
│  ├─ devExecutor.ts   dev 步骤（repair 循环/契约/视觉反馈）——改任务行为主要在这
│  ├─ completion.ts    CompletionContract（系统判定完成）
│  └─ artifacts.ts     产物注册（PG 版本化）
├─ sandbox/
│  ├─ adapter.ts       AgentRuntimeAdapter 接口（所有 executor 的唯一契约）
│  ├─ agentscopeRuntime.ts  ← 主路径（V1.5）：AgentScope 2.0 Harness Adapter
│  ├─ externalToolExecutor.ts ← 外部工具协议执行器（Write/Read/Bash/...）
│  ├─ dockerClaudeCode.ts  Claude Code specialized executor（FORCE_CLAUDE_CODE 回退）
│  └─ runtimeProtocol.ts   Claude Code 通道的工具桥
├─ agentscope/          AgentScope HTTP client + SSE eventMapper
├─ policy/              能力/执行策略/模型策略/token 预算/provider 健康（控制面）
├─ artifacts/           Artifact 系统（service/registry/validator/preview/版本化）
├─ generators/          PPTX/XLSX/DOCX/PDF/HTML 确定性生成器（Product Layer）
├─ browser/             Browser Runtime（playwright 会话/观察/安全/崩溃恢复）
├─ vision/              视觉管线（MiniMax 描述/验证/截图）
├─ workspace/           WorkspaceManager（input/working/output 布局/快照/清单）
├─ tools/               Tool Registry（filesystem/spreadsheet/browser 等）
└─ llm/ complete.ts     非流式补全（planner/内容生成用；opencode-go 通道）
```

每个文件头部 2-3 行注释 = 该模块职责与关键约定；tests/ 是行为契约（改代码跑对应测试）。

## 五、快速定位（遇到具体问题）

- 任务执行异常 → 查 `EXECUTION_STATE.md` 已知缺陷 → `lib/tasks/devExecutor.ts` + 服务器日志
- 产物不对 → `lib/tasks/completion.ts`（契约）→ `lib/artifacts/validator.ts`（格式验证）
- 模型/通道问题 → `lib/opencode.ts` + `lib/llm/complete.ts` + 服务器 .env（AGENTSCOPE_BASE_URL 等）
- 部署/回滚 → `docs/V14_CLOUD_DEPLOY_WORKFLOW.md`
- 项目延续/workspace → `lib/sandbox/agentscopeRuntime.ts`（项目模式 agent 复用）+ `lib/workbench/projectApi.ts`

## 性质标记

- 🔴 活文档：每轮迭代必须更新（EXECUTION_STATE.md / DECISIONS.md）
- 🟡 基线文档：方向性定稿，演进时同步修订（架构/设计类）
- ⚪ 历史记录：事实性审计/验收，只追加不改（V11-V15 审计类）

## 过时文档（命名/定位滞后于演进，读时注意时效）

- `README.md` / `PRODUCT_GOAL.md` / `DEPLOYMENT.md`：v7 时代的"Light Client"表述——产品现已是 Cloud AI Work System；部署流程以 `docs/V14_CLOUD_DEPLOY_WORKFLOW.md` 为准，产品定位以 `PRODUCT_GOAL.md` 的长期目标 + `EXECUTION_STATE.md` 的当前状态为准
- `ACCEPTANCE.md` / `ACCEPTANCE_RC_V7.md`：v7 验收——仅历史参考
- `PHASE_A_TASK_ROUTER_DESIGN.md` / `IMPLEMENTATION_PLAN_CLOUD_AGENT.md`：V1.0 实施规划——已执行完，仅历史参考
