# V1.5 Harness Duplication Audit（2026-08-16）

目标：对照成熟 Agent Harness（AgentScope 2.0 / OpenHands SDK / OpenCode SDK），对 Go AI 自研 Agent 基础设施逐模块定性：KEEP / ADAPT / REPLACE / DELETE。
原则：成熟 Harness 已可靠承担的职责，Go AI 不留第二套实现；**删除代码是有效交付**。

## 职责 → 自研模块 → 候选 对照表（初稿，研究结果回填定论）

| 职责 | 自研模块（行数） | 成熟 Harness 候选 | 定性 | 依据 |
|---|---|---|---|---|
| Agent loop（事件模型+状态推进） | lib/agent/loop.ts (86) | AgentScope Agent loop | 待定 | V15_AGENTSCOPE_SOURCE_AUDIT |
| 执行循环/repair 循环 | lib/tasks/devExecutor.ts runOnce/repair (534) | AgentScope loop + Go AI 契约 | 待定 | 同上 |
| Tool 注册/调用 | lib/tools/registry.ts (319) + spreadsheet(308) + browser(~400) | AgentScope tool 系统 / MCP | 待定 | 同上 |
| Tool 协议（ToolCall/ToolResult） | lib/sandbox/runtimeProtocol.ts (196) | AgentScope 工具协议 | 待定 | 同上 |
| Sandbox 生命周期 | lib/sandbox/{manager,localProvider,dockerProvider,runtime}.ts (643) | AgentScope DockerWorkspaceManager / 外部 sandbox | 待定 | 同上 + V15_OPENHANDS |
| 会话状态（Job/AgentSession） | lib/tasks/job.ts (231) + agent/jobStore.ts | AgentScope session/storage (Redis) | 待定 | 同上 |
| Checkpoint/lease/recovery | worker.ts + job.ts | AgentScope 无原生 → Go AI 控制面 | 待定 | 同上 |
| Cancel/interrupt | worker.ts taskAbort | AgentScope interrupt | 待定 | 同上 |
| 模型调用 | lib/llm/complete.ts (139) + opencode.ts (115) | AgentScope model 封装 | 待定 | 同上 |
| Token 预算 | lib/policy/tokenBudget.ts (149) | 无直接对应 | 待定 | 同上 |
| Provider health/fallback | lib/policy/{providerHealth,providerProbe,modelPolicy}.ts (~300) | 无直接对应 | 待定 | 控制面 |
| 上下文/skill/记忆注入 | lib/tasks/{context,skills,memory}.ts + inputManifest (~500) | AgentScope middleware | 待定 | 同上 |
| Workspace 管理 | lib/workspace/*.ts (~900) | AgentScope LocalWorkspaceManager | 待定 | 同上 |
| 事件流（job events→UI） | lib/job/events.ts (77) + agentscope/eventMapper | AgentScope message bus/SSE | 待定 | 同上 |
| 执行器适配（Claude Code/AgentScope） | lib/sandbox/{adapter,dockerClaudeCode,agentscopeRuntime}.ts (~600) | 薄适配层 | 待定 | 同上 |
| Artifact 系统 | lib/artifacts/*.ts (~700) | **Go AI Product Layer，保留** | KEEP | 用户指令 §8 |
| 生成器（PPTX/XLSX/DOCX/PDF…） | lib/generators/*.ts (~1500) | **Go AI Product Layer，保留** | KEEP | 用户指令 §8 |
| 预览系统 | lib/artifacts/preview.ts + app/api | **Product Layer，保留** | KEEP | 用户指令 §8 |
| 视觉管线 | lib/vision/*.ts (~270) | 无成熟对应（MiniMax 通道） | KEEP/ADAPT | 用户指令 §7 |
| 任务/项目/产物持久化 | lib/tasks/repo.ts (264) + workbench | **控制面，保留** | KEEP | 用户指令 §4 |
| 队列/租约/worker | lib/tasks/worker.ts (486) | **控制面（不重新实现 harness）** | KEEP | 用户指令 §4 |

## 当前主链（自研主导）

```
user → /api/tasks → worker(claim/lease) → generatePlan(规则/LLM) → executeStep
  → [general|research|artifact] = 自研调用（completeChat/generators/exa）
  → [dev] = runDevStep → runAgentJob → AgentRuntimeAdapter
      ├─ GoFileAgentAdapter → file-agent 容器（Claude Code）→ SandboxRunEvent → 自研映射
      └─ AgentScopeRuntimeAdapter → agentscope server HTTP → eventMapper → 自研映射
  → repair 循环（自研 maxAttempts + snapshot 回滚 + 视觉反馈）
  → validateTaskCompletion（自研契约）→ artifact 注册 → UI
```

自研 Agent 基础设施合计 ≈ 9000+ 行（agent/sandbox/tools/job/leader/policy/tasks/llm/workspace/agentscope）。

## 待研究结论（三个 subagent 并行中）

- V15_AGENTSCOPE_SOURCE_AUDIT.md：AgentScope 2.0 源码级能力矩阵（loop/tools/workspace/sandbox/events/session/interrupt/middleware/model）
- V15_OPENHANDS_SOURCE_AUDIT.md：OpenHands SDK 能力矩阵（action/observation/runtime/eventstream/可编程驱动）
- V15_OPENCODE_CLAUDE_SDK_AUDIT.md：OpenCode/Claude Code 可调用接口（specialized executor 定位）

## 收敛目标（用户指令 §4）

```
Web/App → Task Intake → Task+Deliverable Contract → Harness Adapter → Mature Harness
  ├─ Model Provider / Tool System / Workspace / Sandbox / Browser / Files / Skills / Memory
  └─ Execution/Observation Loop → Validator/Repair → Artifact Service → Result UI
旁路 Control Plane：Auth/Task persistence/Queue/Quota/Provider Health/Metrics/Notifications/Artifact metadata
```

停止条件（用户指令 §18）：单条真实 agent_workspace 任务完全由成熟 Harness 驱动；工具/workspace/sandbox 真调用；artifact 真产出；cancel/retry/recovery 真验证；旧 AgentLoop 与 Sandbox lifecycle 删除；无两套并行实现。
