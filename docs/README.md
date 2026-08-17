# Go AI 项目认知地图（文档导航）

> 目的：读完本页 + 按序读对应文件，即可了解项目**全貌**（迭代过程、修改方向、代码架构、怎么改）。
> 用法：新接手 / 续接任务 / 调整方向时，按「一、二、三、四」顺序读；快速定位问题看「五、按需查询」。

## 〇、架构唯一真相（任何 AI / 人类读本项目必读）

| 文件 | 读完得到 |
|---|---|
| **[CURRENT_EXECUTION_ARCHITECTURE.md](../CURRENT_EXECUTION_ARCHITECTURE.md)** | **当前唯一执行架构**：User → Preflight 决策层 → Execution Directive → 控制面（PG/Redis/worker 租约队列）→ **Claude Code**（go-ai-file-agent 容器，唯一主 Harness）→ Go AI Validation（不合格证据回交修复）→ Artifact / Final Answer → Display。含代码地图（"在哪里"）与模型地图（Auto 路由池）。**与本文冲突的一切旧文档一律 HISTORICAL / SUPERSEDED** |

## 一、先读这三份（10 分钟建立全貌）

| 文件 | 读完得到 | 性质 |
|---|---|---|
| [EXECUTION_STATE.md](../EXECUTION_STATE.md) | **迭代全过程**（V1.0→V1.6 每轮做了什么/验证结果/踩坑）+ **当前状态** | 🔴 活文档（每轮更新） |
| [DECISIONS.md](../DECISIONS.md) | **锁定决策**（不可随意推翻的技术决策——调整方向前必读） | 🔴 活文档 |
| [LLM_EXECUTION_CHAIN.md](../LLM_EXECUTION_CHAIN.md) | **执行链语义**：任务怎么从用户意图走到最终产物（为什么这样拆） | 🟡（内容为历史主链，现以 CURRENT_EXECUTION_ARCHITECTURE.md 为准） |

## 二、历史架构文档（SUPERSEDED，不再代表当前设计）

| 文件 | 状态 |
|---|---|
| [V15_HARNESS_CONVERGENCE.md](V15_HARNESS_CONVERGENCE.md) | **SUPERSEDED**（AgentScope 2.0 主 Harness 决策已被本 Goal 翻转：Claude Code 统一主 Harness） |
| [V15_HARNESS_DUPLICATION_AUDIT.md](V15_HARNESS_DUPLICATION_AUDIT.md) | SUPERSEDED（迁移已完成，重复 Harness 已删） |
| [V15_HARNESS_MIGRATION_STRATEGY.md](V15_HARNESS_MIGRATION_STRATEGY.md) | SUPERSEDED（迁移已完成） |
| [GO_AI_CLOUD_AGENT_ARCHITECTURE.md](../GO_AI_CLOUD_AGENT_ARCHITECTURE.md) | HISTORICAL（V7 蓝图：自研 Agent Runner 编排，已由 Claude Code 取代） |
| [V14_CLOUD_DEPLOY_WORKFLOW.md](V14_CLOUD_DEPLOY_WORKFLOW.md) | ✅ **现行**部署/回滚全流程 + 踩坑清单（构建→save→scp→load→rm+run→迁移→矩阵） |

## 三、按需：每轮迭代的审计/验收（改某块前看对应轮次）

| 想改什么 | 先读 |
|---|---|
| Agent 执行/工具 | [V13_DEEPSEEK_TOOL_PROTOCOL.md](V13_DEEPSEEK_TOOL_PROTOCOL.md)（工具调用协议实证）、[V13_RUNTIME_STATE_AUDIT.md](V13_RUNTIME_STATE_AUDIT.md)（状态机） |
| 沙盒/安全 | [V13_SECURITY_MATRIX.md](V13_SECURITY_MATRIX.md)（安全基线+实测）、[V12_SECURITY_ACCEPTANCE.md](V12_SECURITY_ACCEPTANCE.md) |
| 策略/模型选择/预算 | [V12_EXECUTION_POLICY_AUDIT.md](V12_EXECUTION_POLICY_AUDIT.md)、[V12_RUNTIME_BENCHMARK.md](V12_RUNTIME_BENCHMARK.md)（token/时间基线） |
| 视觉/图片任务 | [V11_VISION_VERIFICATION.md](V11_VISION_VERIFICATION.md)（视觉验收方法）、[DEEPSEEK_REASONING_FAILURE_ANALYSIS.md](DEEPSEEK_REASONING_FAILURE_ANALYSIS.md)（"只分析不交付"根因） |
| 能力缺口/下一步 | [V14_CAPABILITY_AUDIT.md](V14_CAPABILITY_AUDIT.md)（能力矩阵：real/partial/missing） |
| Harness 选型背景 | [V15_AGENTSCOPE_SOURCE_AUDIT.md](V15_AGENTSCOPE_SOURCE_AUDIT.md)、[V15_OPENHANDS_SOURCE_AUDIT.md](V15_OPENHANDS_SOURCE_AUDIT.md)、[V15_OPENCODE_CLAUDE_SDK_AUDIT.md](V15_OPENCODE_CLAUDE_SDK_AUDIT.md)、[RESEARCH_CLOUD_AGENT_PROJECTS.md](../RESEARCH_CLOUD_AGENT_PROJECTS.md) |

## 四、代码怎么实现（模块地图，对应 CURRENT_EXECUTION_ARCHITECTURE.md）

```
lib/
├─ taskRouter.ts       用户意图 → chat / artifact / agent_workspace 粗分（纯规则）
├─ preflight/          决策层（"任务编译器"）：directive（合同）· rules（确定性规则）
│                       · models（主模型 Auto）· build · attachments
├─ tasks/
│  ├─ worker.ts        队列/租约/心跳/恢复/取消（控制面）
│  ├─ executor.ts      general/research/artifact/dev 步骤统一转发 runClaudeCodeStep
│  ├─ devExecutor.ts   Claude Code 步骤编排（workspace 就绪/视觉摘要/repair 循环/产物收集）
│  ├─ completion.ts    CompletionContract（契约：格式/页数/数量/文件变化/视觉）
│  ├─ artifacts.ts     产物注册（PG 版本化 + provenance）
│  └─ repo.ts          任务持久化
├─ agent/
│  ├─ runner.ts        runAgentJob（Claude Code 事件流透传，零模型决策）
│  └─ loop.ts          事件状态机（validation_failed→repair，非模型循环）
├─ sandbox/
│  ├─ adapter.ts       AgentRuntimeAdapter 接口
│  ├─ dockerClaudeCode.ts  GoFileAgentAdapter（→ go-ai-file-agent:18082 /task /chat）
│  └─ fakeAdapter.ts   测试用
├─ policy/              模型策略/能力/provider 健康/配额（控制面）
├─ artifacts/           Artifact 系统（service/registry/validator/preview/版本化）
├─ generators/          PPTX/XLSX/DOCX/PDF/HTML 确定性生成器（经 office-mcp 进 Claude Code 工具箱）
├─ browser/             Browser Runtime（playwright；容器侧 browser-mcp 复用）
├─ vision/              视觉管线（MiniMax 描述/验证/截图；服务端预处理兜底）
├─ workspace/           WorkspaceManager（tasks/{id} 或 projects/{pid}；input/working/output）
├─ projects/            Project API（持久 workspace 文件树）
└─ llm/ complete.ts     非流式补全（仅 generators 回退用；不在任务主链）
```

每个文件头部 2-3 行注释 = 该模块职责与关键约定；tests/ 是行为契约（改代码跑对应测试）。

## 五、快速定位（遇到具体问题）

- 任务执行异常 → 查 `EXECUTION_STATE.md` 已知缺陷 → `lib/tasks/devExecutor.ts` + 服务器日志
- 产物不对 → `lib/tasks/completion.ts`（契约）→ `lib/artifacts/validator.ts`（格式验证）
- 主模型没选对 → `lib/preflight/models.ts`（Auto 链：capability→池→health→quota→compatibility）
- 视觉不工作 → 容器 `vision-mcp` → vision-gateway（MiniMax）；服务端 `lib/vision.ts` 兜底
- 部署/回滚 → `docs/V14_CLOUD_DEPLOY_WORKFLOW.md`
- 项目延续/workspace → `lib/workspace/service.ts`（projects/{pid}）+ `lib/projects/api.ts`
- 普通问答 → `/api/chat`（CLAUDE_CHAT_ENABLED=1 时经 file-agent /chat，统一 Claude Code）

## 性质标记

- 🔴 活文档：每轮迭代必须更新（EXECUTION_STATE.md / DECISIONS.md / CURRENT_EXECUTION_ARCHITECTURE.md）
- 🟡 基线文档：方向性定稿，演进时同步修订（架构/设计类）
- ⚪ 历史记录：事实性审计/验收，只追加不改（V11-V15 审计类）

## 过时文档（命名/定位滞后于演进，读时注意时效）

- `README.md` / `PRODUCT_GOAL.md` / `DEPLOYMENT.md`：v7 时代的"Light Client"表述——产品现已是 Cloud AI Work System；部署流程以 `docs/V14_CLOUD_DEPLOY_WORKFLOW.md` 为准，架构以 `CURRENT_EXECUTION_ARCHITECTURE.md` 为准
- `ACCEPTANCE.md` / `ACCEPTANCE_RC_V7.md`：v7 验收——仅历史参考
- `PHASE_A_TASK_ROUTER_DESIGN.md` / `IMPLEMENTATION_PLAN_CLOUD_AGENT.md`：V1.0 实施规划——已执行完，仅历史参考
