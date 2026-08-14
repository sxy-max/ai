# LLM_EXECUTION_CHAIN.md — Cloud AI Work System 执行链（2026-08-14）

> 本文档基于**实际代码路径**梳理（非设计稿）。目标：把系统从「确定性任务系统」升级为「LLM 驱动的任务系统」，并杜绝任务型请求退回普通聊天。

---

## 1. 当前链路（实测，2026-08-14 线上/本地一致）

### 1.1 入口分流（全部在前端 app/chat/page.tsx send()，约 L500-560）

```
用户输入 + 附件
   │
   ▼ classifyTask(message, attachments)  [lib/taskRouter.ts，纯规则 R0-R6]
   │
   ├─ type=artifact（显式文件生成，R1）  → POST /api/tasks  ❌【已实测损坏，见 §3.1】
   │
   ├─ type=agent_workspace（图片/文件修改、R3/R2/R5）
   │     → runFileTask → /api/files/upload（v7 磁盘 workspace）
   │                   → /api/agent/task（v7 file-agent：Claude Code + DeepSeek）
   │     ⚠️ 走的是 v7 旧链路，不经过任务系统/worker/artifact 注册链
   │
   └─ type=chat（其余，R6）→ /api/chat 流式（普通聊天）
```

### 1.2 任务系统主链（/api/tasks → worker，本地全通、线上已部署）

```
POST /api/tasks（goal + files[] multipart）
   ▼ 入库（status=queued，files 绑定）
scripts/task-worker.ts（独立进程，PG 轮询领取 FOR UPDATE SKIP LOCKED，租约+崩溃恢复）
   ▼ runTaskToEnd（lib/tasks/worker.ts）
   ├─ 规划：lib/leader/planner.ts
   │    ├─ planWithLlm()：completeChat（DEEPSEEK_API_KEY 配置时）→ JSON 步骤
   │    └─ planFromRules()：关键词规则（无 key 时）
   ▼ 逐步执行：lib/tasks/executor.ts（4 类 Worker）
   ├─ general   → completeChat（DeepSeek）｜无 key → 确定性 fallback 文案（“未配置回答模型”）
   ├─ research  → lib/exa.ts 搜索 + completeChat 综合｜无 key → 证据聚合报告
   ├─ artifact  → lib/generators/llm.ts（LLM 结构化内容）→ 生成器渲染｜无 key → 模板
   └─ dev       → lib/devWorker/devExecutor.ts → AgentScope 沙盒（streamEvents+triggerRun）
                   ⚠️ 依赖 AGENTSCOPE_URL + agent-runtime/sandbox-daemon（线上未部署，V1.1）
   ▼ 产物注册：lib/tasks/artifacts.ts → artifactService（磁盘）→ /api/artifacts/:id（归属校验下载）
   ▼ 事件：task_events（PG）→ SSE /api/tasks/:id/events；通知表 → /api/notifications
```

### 1.3 视觉链（lib/vision.ts，MiniMax describe）

- 聊天：非 vision 模型图片 → 服务端 MiniMax describe → `UNTRUSTED VISUAL CONTEXT` 注入正文（v7 兼容）
- File Agent（v7）：workspace 图片 → describe → `.go-ai/vision/*.md + *.json` 给 Claude Code
- **任务系统（新链）：图片进任务没有 vision 预处理段**——图片只作为 files 落盘，worker 的 fileSummaries 对二进制只写"（二进制文件，内容不展开预览）"→ LLM/生成器看不到图片内容

### 1.4 当前确定性生成器链（无 DEEPSEEK_API_KEY 时）

```
artifact 步骤 → llmArtifactContent() 返回 null（无 key）→ generateArtifact(kind, {message: prompt})
   ├─ pptx：prompt 文本 → parseDeck（启发式拆句）→ 手写 OOXML（JSZip）
   ├─ xlsx：prompt 文本 → extractSheetData（markdown 表格/CSV 行/兜底单列）
   ├─ html / markdown / csv / docx：同模式（parseDocument/启发式）
   └─ 产物是“结构模板 + 从任务描述抠出的零散信息”，不是真实内容分析
```

---

## 2. 目标链路（DEEPSEEK_API_KEY 接入后）

### 2.1 LLM 三种系统角色（不再当“聊天演员”）

| 角色 | 职责 | 现有接入点 |
|---|---|---|
| **Planner** | 理解任务 → 决定 worker 序列（1-8 步） | `lib/leader/planner.ts planWithLlm()`（已实现，JSON mode） |
| **Generator** | 按 kind 产出真实内容（结构化 markdown/表格/幻灯片提纲） | `lib/generators/llm.ts llmArtifactContent()`（已实现，按 kind 提示词） |
| **Workspace Agent** | 在工作区内读/写/改文件并执行任务 | v7: `/api/agent/task`（Claude Code+DeepSeek，已部署）；新链: `devExecutor→AgentScope`（未部署） |

### 2.2 三类任务的完整目标路线

```
A. 普通问答（咨询/解释/总结等无文件无产物意图）
   入口 → classifyTask=chat → /api/chat 流式（fallback 定位，不抢占任务型请求）

B. 结构化文件生成（做 PPT / 生成 HTML / 导出 CSV/MD）
   入口 → classifyTask=artifact → 【修复后】POST /api/tasks {goal, files}
      → worker → planner（LLM）→ artifact 步骤
      → llmArtifactContent（LLM 产出真实内容）→ generator 渲染
      → Artifact Service 落盘 → 下载
   ❌ 不允许退回 /api/chat 文本回答

C. Workspace Agent 任务（图片+文件修改 / 多文件联动处理 / 项目构建）
   入口 → classifyTask=agent_workspace → 【改造后】POST /api/tasks（type=agent_workspace）
      → worker → dev 步骤 → Workspace Manager（input/输出隔离目录）
      → Agent Runner（优先 AgentScope 沙盒；未部署期回退 v7 file-agent 适配）
      → 产物从 workspace outputs 收集 → Artifact Service → 下载
   ❌ 不允许退回 /api/chat 文本回答
```

### 2.3 不允许退回普通聊天的任务清单（硬约束）

- 含「做/生成/给我+文件类型名词」（PPT/HTML/CSV/MD/Excel/Word/PDF/ZIP）
- 图片 + 修改/复刻/实现动作
- 文件 + 修改/整理/重构/清洗动作
- 纯文本「搭建/开发/实现一个项目」
- 聊天页 UI 已按此路由；**服务端 /api/chat 需加同层防线**（防绕过前端直连）

---

## 3. 实测发现的问题（Phase 1 梳理产出）

### 3.1 ❌【损坏】聊天页 artifact 分支 body 错误（app/chat/page.tsx L544-547）

```ts
// 现状：POST /api/tasks body = { message, attachments }
// /api/tasks 期望：{ goal, fileIds?, title? } —— 无 message 字段
// 结果：goal 为空 → 400 "goal 必填" → 前端提示"文件生成失败"
```
**修复点**：改为 `{ goal: input.trim(), fileIds: <已上传附件对应 files 行> }`——需要附件→files 行（当前聊天附件是内存 File，未上传到 files 表；需先 multipart 上传或改造 /api/tasks 接受 multipart——已支持！→ 聊天页 artifact 分支改用 multipart 直传）。

### 3.2 ⚠️【双链路并存】agent_workspace 走 v7 file-agent，不经过任务系统

聊天页 agent_workspace → runFileTask（v7 `/api/files/upload` + `/api/agent/task`）。该链路：
- 依赖 go-ai-file-agent + cc-auth-gateway 容器（线上在跑，39h+）
- 产物注册走 /api/agent/task 内部逻辑（v7 artifact 表？），**不走任务系统的 task_events/SSE/通知**
- 用户看不到任务卡片/进度（只有聊天气泡内的 Job UI）
**修复方向**：agent_workspace 类请求统一改走 /api/tasks（新链），v7 file-agent 保留为 dev 步骤的本地回退执行器（F20 方案：devExecutor 未部署期 → file-agent 适配）。

### 3.3 ⚠️ 图片进任务系统无 vision 段

新任务链的图片文件只落盘不解析。**修复方向**：worker 的 dev/artifact 步骤前加 vision 预处理（复用 lib/vision.ts MiniMax describe → 结构化描述写入步骤上下文/workspace）。

### 3.4 ⚠️ /api/chat 无服务端任务防线

前端规则可被绕过（curl 直连 /api/chat 发“做 PPT”）。**修复方向**：/api/chat POST 入口加 classifyTask 服务端判定，任务型请求返回 `{route: "/api/tasks", reason}` 拒绝文本回答。

### 3.5 现状能力矩阵（诚实标注）

| 能力 | 状态 | 依据 |
|---|---|---|
| 确定性 PPTX/XLSX/HTML/CSV/MD/DOCX 生成 | ✅ 本地+线上已通 | 生成器 + 线上回归 |
| LLM planner（DeepSeek） | ✅ 代码就绪，未配置 key | planner.ts planWithLlm |
| LLM content generation | ✅ 代码就绪，未配置 key | generators/llm.ts |
| Workspace Agent（AgentScope 沙盒） | ⛔ 未部署（V1.1） | agent-runtime 无容器 |
| Workspace Agent（v7 file-agent 回退） | ✅ 线上在跑 | /api/agent/task |
| 图片 → 任务系统 vision 链 | ⛔ 未实现 | §3.3 |
| 聊天页 artifact 直连 | ❌ 损坏 | §3.1 |
| 服务端任务型防线 | ⛔ 未实现 | §3.4 |

---

## 4. 最小改造点列表（下一步 Phase 2 前置）

| # | 改造 | 文件 | 说明 |
|---|---|---|---|
| M1 | 聊天页 artifact 分支改用 multipart 直传 /api/tasks | app/chat/page.tsx | 修复 §3.1 损坏分支 |
| M2 | agent_workspace 分支改走 /api/tasks（type=agent_workspace） | app/chat/page.tsx | 统一主链，v7 file-agent 降为 dev 回退 |
| M3 | /api/chat 服务端任务型防线 | app/api/chat/route.ts | classifyTask 服务端判定拒绝文本回答 |
| M4 | worker 步骤前 vision 预处理段 | lib/tasks/executor.ts（dev/artifact） | 复用 lib/vision.ts，图片描述入上下文/workspace |
| M5 | /api/tasks 支持 type 字段（chat/artifact/agent_workspace）持久化 | lib/tasks/types.ts + repo.ts | 任务可区分路线，UI 按类型展示 |
| M6 | 配 DEEPSEEK_API_KEY（本地 .env.local → 验证 → 服务器 .env） | 环境 | 激活 planner + generator 主链 |

**Phase 2 顺序建议**：M1+M2+M5（聊天→任务主链打通）→ M6（本地 LLM 验证）→ 任务 A（真实 PPTX）→ 任务 B（图片+文件 Agent Workspace）。
