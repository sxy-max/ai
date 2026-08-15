# V13 Runtime State Audit（2026-08-15，V1.3 WP1）

追踪当前（V1.2）agent_workspace 全链路的**状态归属**，确定 V1.3 必须把哪些状态从"内存/进程内"升级为"持久一等对象"。

## 全链路状态追踪

```
HTTP Request（无状态）
 → POST /api/tasks（PG：tasks 行 + files 绑定 + task_events）
 → Worker 轮询领取（PG：tasks.lease_expires 租约 + agent_runs 步骤记录）
 → ExecutionPolicy（worker 进程内存计算；runtime.json 落盘 workspace）
 → RuntimeAdapter（进程内对象；AgentScope 会话在 AgentScope server 进程/Redis）
 → Sandbox（AgentScope：server 端 workspace + Docker/Local 沙盒；Claude Code：固定 file-agent 容器）
 → Workspace（文件系统 WORKSPACES_ROOT/tasks/{taskId}/ + workspace.json）
 → Agent Loop（worker 进程内 devExecutor 循环 + attempts/*.json repair 记录）
 → Tool（AgentScope server 内工具执行；事件经 SSE→adapter→task_events）
 → Artifact（PG artifacts 行 + LocalObjectStorage 文件）
 → UI（SSE 事件流→前端 Task Detail）
```

## Current State Ownership Map

| 状态 | 内存(进程) | 文件系统 | PostgreSQL | Redis | 依赖 Web | 依赖 Worker | 进程死则任务死 |
|------|-----------|---------|-----------|-------|---------|------------|---------------|
| Task（意图+状态） | — | — | ✅ tasks 表 | — | — | — | ✗ 可恢复 |
| **Job（一次执行）** | ⚠️ 无独立实体（agent_runs 仅步骤级） | — | ⚠️ 部分（steps/events） | — | — | — | **✗ 无 checkpoint** |
| **AgentSession** | ⚠️ adapter 内部变量 | ⚠️ runtime.json/events.ndjson | ✗ | ⚠️ AgentScope server 侧（不可见） | — | — | **✗ 会话随进程丢失** |
| **Sandbox** | ⚠️ AgentScope server 管理 | ✅ workspace 目录 | ✗ | ⚠️ AgentScope server 侧 | — | — | ✗ |
| Workspace | — | ✅ 目录+workspace.json | ✗ | — | — | — | ✅ 文件持久 |
| Execution State（步骤/阶段） | ⚠️ worker 循环变量 | ✅ agent/attempts | ✅ task_steps+task_events | — | — | — | ⚠️ 步骤可续 |
| Event Stream | — | ✅ events.ndjson | ✅ task_events | — | — | — | ✅ |
| Artifact | — | ✅ ObjectStorage | ✅ artifacts | — | — | — | ✅ |
| ExecutionPolicy | ⚠️ worker 内存 | ✅ runtime.json（摘要） | ✗ | — | — | — | ⚠️ 重算（确定性） |
| Provider Health | ⚠️ 内存 registry | ✗ | ✗ | ✗ | — | — | ✗ 探测即失 |
| Lease | — | — | ✅ tasks.lease_expires | — | — | — | ✅ 可回收 |
| Checkpoint | ✗ | ⚠️ attempts（仅 repair） | ✗ | ✗ | — | — | **✗ 无法断点续跑** |

## 关键结论（V1.3 必须修）

1. **Job 不是一等对象**：Task.status 同时承担意图与执行状态；无 job_id/attempt/sandbox_id/workspace_id 归属记录。
2. **AgentSession 不存在**：AgentScope 会话在 server 侧（我们不可见/不可恢复）；Claude Code 执行是"一次性容器任务"（file-agent 容器固定，无 per-task 会话）。
3. **Sandbox 无管理**：无 allocate/terminate/health API；Claude Code 路径根本不分配沙盒（固定容器共享）。
4. **无 checkpoint**：worker 崩溃后任务从 queued 重跑整个 plan（V1.1 recoverOrphanedTasks 回滚步骤）——**不能从断点继续**。
5. **无 workspace snapshot**：无法 rollback 步骤（repair 时只能重新执行，不能恢复 before-step 状态）。
6. **Provider health 是进程内存**：/api/models 每次请求探测；无后台 probe/持久化。
7. **Claude Code Runtime 无沙盒语义**：file-agent 容器是长期固定容器（非 per-task 隔离）——V1.3 Docker Sandbox 需覆盖两条 runtime 路径。
8. **Artifact 无 provenance**：缺 jobId/workspaceId/sourceFiles/validator 记录。

## V1.3 目标状态（七类独立运行状态）

Task（意图）→ Job（执行，DB 一等对象+lease）→ AgentSession（可持久会话）→ Sandbox（可分配/终止）→ Workspace（snapshot+manifest）→ Execution State（checkpoint 每步）→ Event Stream（既有）→ Artifact（provenance）。
