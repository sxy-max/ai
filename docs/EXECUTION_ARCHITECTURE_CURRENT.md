# Execution Architecture — Current State & Audit（2026-08-14 Goal Mode WP1）

## 6 种请求真实路径追踪

| # | 请求 | 分类 | 路径 | 状态 |
|---|------|------|------|------|
| A | 普通问答 | chat | chat page → classifyTask=chat → /api/chat 流式 | ✅ 正确 |
| B | 生成 PPT | artifact | chat page → /api/tasks(multipart) → worker → planner → artifact 步骤 → llmArtifactContent(null 无key) → pptx 模板生成器 → Artifact | ✅ 链通；内容质量待 WP6 |
| C | 生成 HTML | artifact | 同上 html 生成器 | ✅ 链通 |
| D | 上传 MD 整理返回文件 | agent_workspace | chat page → /api/tasks(type=agent_workspace) → worker → **dev 步骤 → DEV_WORKER_UNAVAILABLE 失败** | ❌ 执行器未接 |
| E | 图片+HTML 按截图改 | agent_workspace | 同上 | ❌ 执行器未接 + vision 未进任务链 |
| F | 多文件/ZIP 项目处理 | agent_workspace | 同上 | ❌ 执行器未接 |

## 关键发现（复用主线）

1. **v7 file-agent 链已是完整 Agent Runtime**：`SandboxRuntimeAdapter`（lib/sandbox/adapter.ts）→ `GoFileAgentAdapter`（dockerClaudeCode.ts，Claude Code + DeepSeek V4 Flash，线上容器 go-ai-file-agent:18082 + cc-auth-gateway:18081）→ `runAgentJob`（lib/agent/runner.ts：job 生命周期+事件流+task spec+产物登记）→ `JobEvent`（lib/job/events.ts：**已结构化**，queued/creating_workspace/reading_files/planning/editing/running_check/generating_artifact/done/failed）→ `WorkspaceManager`（lib/workspace/service.ts：**已安全**，path traversal/symlink/限额/input/output/artifacts/task/internal 目录）。
2. **这就是用户指定的 Claude Code Runtime**（Claude Code + DeepSeek V4 Flash）。WP3 不是新写，是把这条链**正式接入任务系统 dev 步骤**，并补缺口。
3. 任务系统（/api/tasks → worker → executor dev）与 v7 链**双轨并存**：dev 步骤应调用 v7 链（复用），而不是 AgentScope（未部署）。

## 问题清单（按修复优先级）

- P1 dev 步骤无执行器 → 接 runAgentJob（v7 链入任务系统）
- P2 v7 产物不写 PG artifacts 表（无归属/版本化/任务关联）→ registerArtifact 改走 registerTaskArtifact
- P3 JobStore 内存态（跨重启丢）→ 任务事件已 PG（task_events），dev 步骤事件映射进 task_events
- P4 workspace 缺 vision/working/logs 语义 → 扩展 buildDirs
- P5 任务链图片无 vision 预处理 → scanWorkspaceVision 接入 dev 步骤（v7 已有）
- P6 聊天内 transform.ts 把模型文字提取成文件（伪 artifact）→ 保留为 chat fallback，不占主链
- P7 双规划路径（TS planner vs Claude Code 自规划）→ 保持：TS planner 定步骤，dev 步骤内 agent 自执行
- P8 事件两套（JobEvent vs TaskEventType）→ dev 步骤事件双向映射
- P9 AgentScope agent-runtime 未部署 → 不作为本轮执行器；Claude Code Runtime 为主
- P10 无任务型服务端防线（/api/chat 可被直连绕过）→ WP2 加

## 架构决策（本轮）

- 执行主链：user → classifyTask → /api/tasks → worker → planner → executor（general/artifact 现链 + **dev = runAgentJob(v7 链)**）→ PG artifacts → 下载
- Agent Runtime 第一实现 = GoFileAgentAdapter（Claude Code + DeepSeek V4 Flash，线上容器）
- 普通聊天 = fallback 分支（保留 /api/chat），任务型请求服务端拒绝落 chat
