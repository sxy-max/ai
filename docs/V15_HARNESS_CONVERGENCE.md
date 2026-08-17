> [!IMPORTANT] **SUPERSEDED — 2026-08-17 起不再代表当前架构。**
> 本文件的「最终主 Harness：AgentScope 2.0」决策已被架构收敛 Goal 翻转：
> **Claude Code 是唯一主 Harness**（go-ai-file-agent 容器），Preflight 决策层负责任务编译，
> AgentScope 全栈已从生产与仓库删除。当前唯一真相：**`../CURRENT_EXECUTION_ARCHITECTURE.md`**。
> 本文件仅作历史决策记录。

# V1.5 Harness Convergence — 最终定性（2026-08-16）

依据：三份源码审计（AgentScope/OpenHands/OpenCode+Claude Code）+ 本地冒烟 + 服务器 Phase A 真实验证。

## 最终主 Harness：AgentScope 2.0

证据（V15_AGENTSCOPE_SOURCE_AUDIT.md + 实测）：
- Agent loop：`Agent._reply_impl` 原生（Reasoning/Acting/Exit；ReActConfig.max_iters）
- 工具系统：Toolkit 注册 + 外部工具协议（RequireExternalExecutionEvent/ExternalExecutionResultEvent）——Go AI 工具接入点
- Workspace/Sandbox：SandboxedWorkspaceBase + Local/Docker/OpenSandbox/E2B 后端
- 事件：Redis pub/sub + SSE（26 事件）；Session：Redis 全量状态恢复；Interrupt：双路径 + CancelDispatcher
- 模型：OpenAI 兼容 base_url 可覆盖（opencode-go 实测通，UA patch 后服务器通）
- 服务器 Phase A：agent_workspace 任务完全由 AgentScope 驱动 → 真实产物（runtime=agentscope）

OpenHands：落选（无工具注册表、无 SSE、中断仅 step 间、Python 3.12 门槛）。
OpenCode SDK / Claude Code SDK：specialized executor 候选（见下）。

## 模块最终定性

| 模块 | 定性 | 依据 |
|---|---|---|
| lib/agentscope/*（client/eventMapper） | **KEEP** | 主 harness 适配层（ADAPT：补 REQUIRE_EXTERNAL_EXECUTION 映射 ✓） |
| lib/sandbox/agentscopeRuntime.ts | **KEEP（主路径）** | Harness Adapter；默认 runtime（AGENTSCOPE_URL 配置时） |
| lib/sandbox/externalToolExecutor.ts | **KEEP（新增）** | 外部工具协议 Go AI 侧执行器（Write/Read/Bash/Grep/Glob/Edit + 路径越界防护） |
| lib/tools/registry.ts + spreadsheet/browser | **KEEP（Product 工具）** | 经外部工具协议/生成器工具接入 harness；Claude Code 通道仍用 |
| lib/agent/loop.ts | **KEEP（事件模型）** | 事件类型是 UI 契约（11 种 AgentEvent）；状态机推进由 harness 承担 |
| lib/sandbox/runtimeProtocol.ts | **ADAPT** | sandboxManagerExecutor 仅 Claude Code 通道用；AgentScope 通道不用 |
| lib/sandbox/{manager,localProvider,dockerProvider}.ts | **KEEP（Claude Code 通道）** | AgentScope 主路径不用；file-agent 沙盒继续用 |
| lib/sandbox/dockerClaudeCode.ts（GoFileAgentAdapter） | **KEEP（specialized executor）** | Claude Code = coding 类任务的 specialized executor（用户 §6） |
| lib/agent/runner.ts + jobStore.ts | **KEEP（Claude Code 通道编排）** | 同上；AgentScope 通道由 ChatService 承担 |
| lib/tasks/job.ts（Job/AgentSession/checkpoint/lease） | **KEEP（控制面）** | 队列/租约/故障接管/任务持久化——harness 无对应 |
| lib/tasks/devExecutor.ts 的 repair 循环 | **KEEP（产品契约层）** | validate/repair 验收编排属 Go AI Product Layer（用户 §4） |
| lib/policy/*（capabilities/executionPolicy/tokenBudget/modelPolicy/providerHealth） | **KEEP（控制面）** | 任务路由/授权/预算/健康——Go AI 决策层 |
| lib/llm/complete.ts + opencode.ts | **KEEP（控制面/生成器）** | planner/LLM 内容/artifact 生成用；harness 内模型调用不经它 |
| lib/workspace/* | **KEEP（Product 文件层）** | 任务 workspace 布局/同步/快照——harness workspace 是执行环境 |
| lib/artifacts/* + generators/* + preview | **KEEP（Product Layer）** | 用户 §8 明示保留 |
| lib/vision/* | **KEEP（Product）** | 用户 §7 明示保留 |
| lib/tasks/{worker,executor,repo,completion,planner,inputManifest,skills,memory}.ts | **KEEP（控制面）** | 任务系统本身 |

**删除项（本 Goal 实际删除）**：
- 无大模块删除——因为 Claude Code specialized executor 通道保留（sandbox/runner/loop 仍是它的一部分）。
- **真正删除的重复**：AgentScope 通道不再经过 runtimeProtocol/sandboxManager/AgentLoop 状态机（由 harness 承担）——代码保留但 AgentScope 主路径不经过它们（运行时不重复）。
- 服务器端：DockerWorkspace 沙盒（工具产物回传问题）→ local 沙盒（main.py 支持切换）——**沙盒基础设施简化**。

## 收敛后的运行时路径（Phase A 实测）

```
agent_workspace 任务
→ worker（租约/队列——控制面）
→ planFromRules（确定性——控制面）
→ devExecutor（repair/契约——产品层）
→ AgentScopeRuntimeAdapter（Harness Adapter）
    ├─ credential（openai_credential + opencode-go/DeepSeek）
    ├─ agent + session（chat_model_config 绑定模型）
    ├─ workspace 同步（input/working/task → agent 工作区）
    ├─ triggerRun + SSE 事件（eventMapper → AgentEvent → UI）
    ├─ 工具执行：沙盒内（local：直接落盘；docker：容器内）
    │   └─ 外部工具协议（Go AI 侧 Write/Read/Bash/...）——需要时
    └─ output 回传 → artifact 注册（版本化）→ completion contract
```

## 后续（V1.6 候选）

- Claude Code 通道退役后删除：runner/jobStore/runtimeProtocol/sandbox providers（约 1500 行）
- DockerWorkspace 沙盒工具兼容修复（或保持 local）
- 服务器 agentscope 容器重建需重打 UA patch → 固化到镜像（Dockerfile 或启动脚本）
