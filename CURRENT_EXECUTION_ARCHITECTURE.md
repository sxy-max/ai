# CURRENT_EXECUTION_ARCHITECTURE.md — Go AI 唯一执行架构（2026-08-16 定稿）

> 本文件是当前设计与生产的唯一真相。与本文冲突的历史文档一律视为
> **HISTORICAL / SUPERSEDED**（列表见文末）。任何 AI 读取本项目，以此文件为准。

## 一句话

Go AI = **Cloud AI Work System**：用户输入问题/文件/图片/项目 →
**Preflight** 编译成执行指令 → **Claude Code**（唯一主 Harness，隔离工作区）自主完成
→ **Go AI Validation** 验收（不合格则证据回交 Claude Code 继续修）→
**Artifact / Final Answer** → **Display**。

## 主执行链（第一屏）

```
User Input (goal + files + images + project)
        │
        ▼
Preflight Decision Layer（lib/preflight/）        ← 任务编译器，不是 Agent
  · 任务类型 / 最终结果 / 主模型 Auto / MCP / Tools / Workspace / Skills+Memory / 交付契约 / 验收条件
        │
        ▼
Execution Directive（WHAT + CONSTRAINT + CAPABILITY，不含 HOW）
        │
        ▼
控制面（保留）：/api/tasks → PG/Redis → worker（租约/队列/恢复/取消/checkpoint）
        │
        ▼
ClaudeCodeExecutor（唯一智能执行体 = go-ai-file-agent 容器）
  · 用户原始要求 + 输入材料 + 任务处理方向 + 相关 Skills/Memory → Claude Code
  · Claude Code 自主：理解 → 规划 → 执行 → 观察 → 修改 → 调用专业能力 → 验证自己的工作 → 修正
  · 专业能力 = Claude Code 的工具箱（容器内 MCP/Tool）：
      vision-mcp（MiniMax 视觉，UNTRUSTED 数据处理）
      browser-mcp（playwright，DOM 优先、视觉问题才截图）
      office-mcp（pptxgenjs / exceljs / docx / pdf 物理文件格式）
      search-mcp（Exa 网页研究）
  · 事件流 → task_events → SSE → UI（现有显示层原样）
        │
        ▼
Go AI Validation（lib/tasks/completion.ts + lib/artifacts/validator.ts + 视觉验证）
  · 契约校验：真实格式、页数/数量、文件变化、视觉使用
  · 不合格 → 结构化失败证据交回当前 Claude Code 工作上下文 → 继续修（有界轮数）
  · 合格 → Artifact（PG 版本化）/ Final Answer
        │
        ▼
Display Layer（/tasks/:id、/artifacts/:id、/projects、/chat 消息流）
  · 只负责显示：Text / Markdown / Artifact / Preview / Download / Task Progress
  · 不决定路线、不调模型重做、不偷改结果
```

## 关键决策（当前设计）

| # | 决策 | 内容 |
|---|---|---|
| D1 | **Claude Code 是唯一主 Harness** | 一切智能执行（普通问答/推理/代码/PPT/Excel/DOCX/PDF/浏览器/视觉/研究/项目延续）都由 Claude Code 完成；任务差异来自 directive（主模型/MCP/Tools/Workspace/契约），不是另一套 Agent |
| D2 | **Preflight 是编译器，不是 Agent** | 确定性规则优先（附件类型/明确动作/输出格式/项目状态），仅语义模糊时调用轻量模型分类路线；不规划 HOW |
| D3 | **Execution Directive 精简合同** | WHAT + CONSTRAINT + CAPABILITY。字段见 `lib/preflight/directive.ts` |
| D4 | **主模型 Auto** | 默认 Auto：任务能力 → 批准模型池 → Provider 健康 → 配额 → Claude Code 兼容 → 主模型。Coding/Workspace 默认 **DeepSeek V4 Flash**（现有资产，不因理论排名替换） |
| D5 | **专业模型与主模型分离** | MiniMax = Vision Specialist（仅经 vision-mcp 进入，不接管任务、不重启会话） |
| D6 | **专业能力 = Claude Code 工具箱** | 现有 Presentation/Spreadsheet/DOCX/PDF/Browser/Vision/Search/Artifact/ZIP 全部保留，经 MCP/Tool 由 Claude Code 决定何时调用；Generator 解决物理格式，Claude Code 解决内容与决策 |
| D7 | **Validation 归 Go AI** | Claude Code 声称完成不生效；契约/格式/视觉三重校验；失败证据回交当前上下文继续修 |
| D8 | **AgentScope 退出主链** | 不再作为默认 Harness；代码保留为 legacy（`AGENTSCOPE_URL` 配置才可用），生产默认路径不经过 AgentScope Agent Loop |
| D9 | **控制面全部保留** | Task/Job/PG/Redis/Queue/Lease/Recovery/Cancel/Workspace/Project/Artifact/Preview/Provider Health/Quota/Failure taxonomy/Notification/Auth/Settings/Memory/Skills/Mobile UI 均不重建 |
| D10 | **普通问答统一走 Claude Code** | /api/chat = 轻量 Claude Code Execution Profile（无持久沙盒、最小工具、通用模型），架构与任务系统同一条链 |
| D11 | **Sandbox = Claude Code 的工作电脑** | go-ai-file-agent 容器：隔离、非 root、仅 workspace、真实 key 经 cc-auth-gateway 隔离、超时/取消/恢复由控制面承担 |
| D12 | **Project = 持久 Workspace** | projects/{projectId} 跨任务共享，Claude Code 继续当前项目而非每次从 ZIP 重来 |

## 一次用户任务从输入到输出（真实路径）

```
1. 用户提交 goal + 附件（/ 任务启动器 或 /chat 页）
2. classifyTask（lib/taskRouter.ts，纯规则）粗分 chat / artifact / agent_workspace
3. POST /api/tasks → PG queued（multipart 文件落盘 + files 表绑定）
4. worker 领取（FOR UPDATE SKIP LOCKED + 90s 租约 + 心跳 + 孤儿回收）
5. Preflight.buildDirective（lib/preflight/）：任务类型、能力（vision/browser/office/search/code/general）、
   主模型 Auto（providerHealth+quota 参与）、MCP 清单、工具授权、workspace 模式（tasks/{id} 或 projects/{pid}）、
   交付契约（kind/minCount/页数/格式）、相关 Skills/Memory 选择
6. planFromRules 生成单一 agent 步骤（不再有 general/artifact/dev 多型智能步骤）
7. runClaudeCodeStep：
   a. workspace 就绪（input/ 只读原件、working/ 副本、output/ 交付物、vision/ 视觉上下文）
   b. 图片 → vision-mcp 预处理摘要（UNTRUSTED 标记，内联进 prompt）
   c. Execution Directive + 用户原始要求 + 材料清单 + Skills/Memory → file-agent 容器
   d. Claude Code（主模型 = directive.mainModel）自主执行：读项目 → 规划 → 改文件 →
      调 browser-mcp 渲染检查 / office-mcp 生成真实 .pptx/.xlsx/.docx/.pdf /
      vision-mcp 看参考图并比较 → 自验证 → 写入 output/
   e. 事件（tool/text/result/artifacts/done）→ task_events → SSE → UI
8. 产物收集（adapter 上报 + 根目录兜底）→ registerTaskArtifact（PG 版本化 + 归属 + provenance）
9. Go AI Validation（契约 + ArtifactValidator 格式 + VISION_VERIFY 视觉对比）：
   - 不合格 → 回滚快照 → 证据（缺失项/格式错误/视觉差异）作为修复指令回交同一工作区重跑（有界 2-3 次）
10. 完成 → 通知 → Display（任务页 + 产物预览页，Artifact-first）
```

## 代码地图（回答「在哪里」）

| 问题 | 答案 |
|---|---|
| 输入在哪里判断？ | `lib/taskRouter.ts`（粗分）+ `lib/preflight/rules.ts`（能力/契约）+ `lib/preflight/models.ts`（主模型 Auto） |
| Claude Code 在哪里启动？ | `lib/tasks/devExecutor.ts → runClaudeCodeStep` → `lib/sandbox/dockerClaudeCode.ts`（GoFileAgentAdapter → go-ai-file-agent:18082） |
| 模型在哪里选？ | `lib/preflight/models.ts`（Auto：capability→pool→health→quota→compatibility）；`lib/policy/modelPolicy.ts`（角色链）；`lib/policy/providerHealth.ts`（健康） |
| MiniMax 在哪里调？ | 容器内 `vision-mcp`（复用 `D:\codex\claude-vision-mcp`）→ vision-gateway → minimax-m3；服务端预处理 `lib/vision.ts`/`lib/vision/workspaceScanner.ts` 兜底 |
| Workspace 在哪里？ | `lib/workspace/service.ts`（tasks/{taskId} 或 projects/{projectId}，input/working/output/vision/artifacts/logs） |
| Artifact 在哪里收？ | `lib/tasks/artifacts.ts registerTaskArtifact` → `lib/artifacts/service.ts`（PG 版本化 + 磁盘 + provenance） |
| Validator 在哪里？ | `lib/tasks/completion.ts`（契约）+ `lib/artifacts/validator.ts`（格式）+ `lib/vision/verification.ts`（视觉对比） |
| UI 在哪里显示？ | `app/tasks/[id]/page.tsx`（SSE 实时）、`app/artifacts/[id]/page.tsx`（预览）、`app/projects`、`components/job/JobCard.tsx`、`components/artifact/ArtifactCard.tsx` |

## 模型地图（Auto 路由池）

| 模型 | 角色 | 状态 |
|---|---|---|
| deepseek-v4-flash | Coding / Workspace / Agent 默认主模型 | ✅ 默认 |
| deepseek-v4-pro | 复杂推理候补 | ✅ 候选 |
| kimi-k3 / glm-5.2 / qwen3.8-max | 推理/通用候补（真实 Harness Benchmark 决定胜出者） | ⏸ 候选 |
| minimax-m3 | **Vision Specialist**（仅经 vision-mcp） | ✅ Specialist |
| gpt-5.6-luna | Provider 保留；健康+地区可用时才进候选 | ⏸ 门控 |
| grok-4.5 | 上游 503 | ❌ Disabled |

## 删除/旁路清单（本 Goal 收敛后）

- **删除（重复 Harness / 未接入死代码）**：
  - `lib/sandbox/manager.ts` + `dockerProvider.ts` + `localProvider.ts`（Sandbox 生命周期全套，未接入生产）
  - `lib/generators/engine.ts` 的**执行器用法**（engine 实现保留为 office-mcp 工具层）
  - `lib/agent/jobStore.ts`（进程内 Job，与 `lib/tasks/job.ts` PG Job 重复）→ 由 runner 内联状态替代
  - `lib/workbench/*`（AgentScope 沙盒工作台平行链）→ 退役
- **旁路（保留代码、退出主链）**：`lib/sandbox/agentscopeRuntime.ts` + `lib/agentscope/*`（legacy，`AGENTSCOPE_URL` 才可用）；`services/agent-runtime`（服务器容器停止）
- **保留（控制面/产品层）**：worker/租约/恢复、job、repo、completion、artifacts、workspace、policy、vision、browser、generators 实现、preview、notify、metrics、auth、personalization、skills、memory、toolRegistry（前端）等

## 验证矩阵（真实验收）

见 `scripts/` 云端矩阵（cloud-*.mjs）与本地 `tests/`。综合验收场景：
网站 ZIP + 参考 UI 截图 + CSV 数据 + Markdown 需求 → 重构页面 + 数据整合 + 移动端 +
浏览器渲染 + MiniMax 视觉比较 + 修复 + 打包 README+ZIP，完整经过 Preflight → Claude Code →
DeepSeek → MiniMax MCP → Browser → Workspace → Artifact → Validation → Repair。

## HISTORICAL / SUPERSEDED

以下文档描述的是历史设计，**不代表当前架构**：
- `GO_AI_CLOUD_AGENT_ARCHITECTURE.md`（V7 蓝图：Agent Runner 自研编排）— HISTORICAL
- `docs/V15_HARNESS_CONVERGENCE.md`（AgentScope 2.0 为主 Harness 的决策）— SUPERSEDED（本 Goal 翻转）
- `docs/V15_HARNESS_MIGRATION_STRATEGY.md` / `V15_HARNESS_DUPLICATION_AUDIT.md` — SUPERSEDED（迁移已完成）
- `docs/EXECUTION_ARCHITECTURE_CURRENT.md` — SUPERSEDED
- `DEPLOYMENT.md`（Vercel 部署）— HISTORICAL
- `README.md` 中与本文冲突的任务/工作台描述 — 以本文为准
- `EXECUTION_STATE.md` — 历史状态日志（保留作为记录，架构以本文为准）
