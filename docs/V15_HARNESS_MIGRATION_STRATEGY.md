# V1.5 Harness Migration Strategy（2026-08-16）

原则（用户指令 §10/§11/§14）：不搞大爆炸重写。compatibility adapter 双路径 → 真实验收对比 → 按依赖顺序 replace-verify-delete。**新增代码最少、删除代码最多、系统更简单能力更强**。

## 迁移阶段

### Phase 0：研究定论（进行中）
- V15_AGENTSCOPE_SOURCE_AUDIT.md（首选 harness 证据）
- V15_OPENHANDS_SOURCE_AUDIT.md / V15_OPENCODE_CLAUDE_SDK_AUDIT.md（备选 + specialized executor 定位）

### Phase 1：Compatibility Adapter（薄层）
目标：同一任务可走旧/新两条路径。

```
现有 Go AI Task（agent_workspace 类型）
  ├─ 旧路径（当前）：runDevStep → GoFileAgentAdapter / AgentScopeRuntimeAdapter → repair loop
  └─ 新路径（V1.5）：HarnessAdapter → AgentScope Agent（tools/workspace/sandbox 由 Go AI 注入）
```

HarnessAdapter 契约（薄适配，不复制 harness）：
- `execute(task, workspace, tools, contract, events)` → 把 Go AI Task 翻译为 AgentScope 对话（input_msg + agent 配置），订阅 AgentScope 事件流 → 映射为 Go AI AgentEvent（现有 UI 事件模型不变）
- 工具注入：Go AI 生成器/artifact/browser/spreadsheet 工具经 AgentScope 工具机制注册（extra_agent_tools 或 tool 服务）
- 工作区：input/working/output 与 AgentScope workspace 同步（复用现有 WorkspaceManager 文件层）
- 完成判定：仍走 Go AI CompletionContract（Product Layer）

### Phase 2：Parity 验收（双路径对比）
任务矩阵（用户指令 §12 A-K）每条跑旧/新路径，对比：结果 / token / 时间 / 工具调用数 / 失败模式 / artifact / 恢复能力。
通过标准：新路径达到或超过旧路径。

### Phase 3：逐层删除（按依赖顺序）
候选删除（研究定论后确认）：
- lib/agent/loop.ts（事件模型保留为映射目标，状态机由 harness 承担）
- lib/sandbox/runtimeProtocol.ts 的 sandboxManagerExecutor（工具分发交给 AgentScope）
- lib/sandbox/{manager,localProvider,dockerProvider}.ts（sandbox 生命周期交给 AgentScope workspace/sandbox；或保留为 Provider 注入）
- lib/agent/runner.ts / jobStore.ts（job 编排交给 ChatService/MessageBus）
- devExecutor 的 runOnce/repair 循环（repair 由 Go AI 契约层保留——用户指令 §4 Validator/Repair 属于产品层）

### Phase 4：本地 RC → 云端部署 → 云端矩阵 → rollback
沿用 V14_CLOUD_DEPLOY_WORKFLOW.md。

## 收敛后的模块地图（目标）

```
Go AI Product Layer（保留/KEEP）：
  Task Intake / Deliverable Contract / CompletionContract / Artifact 系统+生成器+预览 /
  Project workspace / InputManifest / 控制面（队列/租约/配额/健康/指标/通知/鉴权）/
  UI（任务/产物/项目页）

Harness Adapter（ADAPT，薄）：
  HarnessAdapter（Task→AgentScope 翻译 + 事件映射）
  工具注册（生成器/artifact/browser/spreadsheet 作为 AgentScope tools）
  Workspace 同步

Mature Harness（REPLACE 目标）：
  AgentScope 2.0（agent loop / tool system / session/storage / message bus / cancel / long-running）

Specialized Executor（保留，定位调整）：
  Claude Code（file-agent 容器）——coding 类任务的 specialized executor，可被主 Agent 调用
  opencode-go 通道——模型提供方
```

## 不变量
- 用户能力不回退（V1.2-V1.4 测试矩阵 = 保护网）
- 控制面不重新实现 harness
- 视觉/Artifact/生成器永远属于 Go AI
- 云端基础设施（网络/proxy/nginx/密钥）不动
