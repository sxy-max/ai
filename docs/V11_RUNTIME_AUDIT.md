# V11 Runtime Audit（2026-08-15，V1.1 WP1）

## 六路径现状（继承 V1.0 实测）

| 路径 | 现状 | 关键层 |
|------|------|--------|
| T-A MD→修改→MD | ✅ 已通（V11 目标：加完成契约+格式验证） | dev 步骤→runAgentJob→兜底收集 |
| T-B 图片+HTML→HTML | ✅ 已通（T8 曾 PASS；路径契约修复后稳定） | vision→workspace→agent |
| T-C ZIP→多文件→ZIP | ✅ 已通（T9；重打包依赖 agent 自觉） | 同上 + archive |
| T-D PPTX | ✅ 已通（pptxgenjs + PresentationSpec） | artifact 步骤 |
| T-E 失败 Agent Task | ✅ 明确失败（TASK_NO_ARTIFACT/DEV_RUNTIME_UNAVAILABLE） | worker 完成校验 |
| T-F 声称完成无 Artifact | ✅ 判定为失败；❌ 无自动修复循环 | worker TASK_NO_ARTIFACT |

## 12 问（逐条实测结论）

1. **哪层决定 Agent 成功**：worker 完成阶段校验（agent_workspace 任务 artifacts.length>0）+ devExecutor outcome（exitCode 0）。**模型文本不参与判定** ✓
2. **哪层验证产物**：devExecutor 目录兜底收集（存在性）+ worker 计数。**无格式验证** → V11-WP12
3. **exitCode 与任务状态**：runAgentJob result.ok（done+exitCode 0）→ step completed；exitCode≠0 → partial 但仍 step.completed，由任务级校验兜底
4. **Artifact 事件 vs 目录扫描**：双轨——容器 artifacts 事件注册 + collectOutputs 目录扫描（output/artifacts/根目录）✓
5. **Workspace 生命周期**：devExecutor 创建；worker 每 6h cleanupExpired（TTL 7 天）。**缺 agent/attempts、events.ndjson、logs/、verification/** → V11-WP4
6. **Agent 是否依赖特殊目录**：是——容器按 {conversationId}/{jobId} 定位（convId="tasks"、jobId={taskId}，上轮修复）；task.md 流程指令（input 只读→working→output）
7. **Agent 状态机**：任务侧有 TaskStatus（queued→planning→running→completed/failed）；容器侧 Claude Code 自有。**缺 validating/retrying/preparing_workspace 状态** → V11-WP11
8. **重试在哪**：devExecutor 无产物自动重试 1 次（强化指令）；用户 PATCH retry/continue。**无结构化 repair loop（attempt 记录）** → V11-WP3
9. **crash 恢复**：recoverOrphanedTasks（租约过期 → queued 重新入队，running 步骤回滚）✓
10. **worker 重启 unfinished**：recovery sweep 在 worker 循环入口执行 ✓；任务恢复续跑（plan 复用）
11. **stdout/stderr 保存**：❌ 无持久化（事件流只映射 tool/progress/result）→ V11-WP4 logs/
12. **声称完成没写文件**：TASK_NO_ARTIFACT 明确失败 ✓；**无自动修复** → V11-WP3

## 架构决策（V1.1 主线）

- 完成判定：系统级 ArtifactCompletionContract（expectedArtifacts 校验）替代"有产物就行"
- 修复循环：Execute→Validate→Repair→Validate（有限次数，attempts 落盘）
- Runtime 分层：Task → SandboxRuntimeAdapter（DockerSandboxRuntime）→ ClaudeCodeRuntimeAdapter；业务只认 runtimeId/workspaceId
- Workspace 2.0：agent/（runtime.json/attempts/events.ndjson）+ logs/ + verification/
- Artifact 独立持久化（ObjectStorageAdapter），不随 workspace 清理
