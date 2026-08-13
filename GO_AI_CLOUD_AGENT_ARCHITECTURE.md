# Go AI Cloud Agent Workspace 架构

> 日期：2026-08-13 ｜ 基于 `RESEARCH_CLOUD_AGENT_PROJECTS.md` 的结论制定
> 一句话：**Go AI = 网页入口(Next.js) + Task Router + Workspace Manager + Sandbox Service(SandboxRuntimeAdapter) + Agent Runner + Job Event Stream + Artifact Service + Vision/File 预处理 + 前端 Job UI**。主执行体沿用「Docker 容器 + Claude Code + DeepSeek V4 Flash」，但从 API 路由中抽离为 Adapter。

---

## 一、现状与差距（GAP 分析）

当前 Go AI（`D:\Projects\go-ai`）已有的雏形与目标之间的差距：

| # | 目标能力 | 当前状态 | 差距 |
|---|---|---|---|
| 1 | Task Router | `lib/toolRegistry.ts` 的 `isFileTaskPrompt()` 字符串启发式 + 前端 `send()` 里硬编码分叉 | 只有 Chat / FileAgent 二分；无结构化 `task.type`；路由判断散落在前端 |
| 2 | Workspace Manager | `app/api/files/upload/route.ts` 与 `app/api/agent/task/route.ts` 各自 `path.join(WORKSPACES_ROOT, conv, job)` + mkdir | 无抽象；无 temp/persistent/file-agent 三类区分；无清理/归档；无会话级复用 |
| 3 | Sandbox Runtime | `app/api/agent/task/route.ts` 硬编码代理到 `go-ai-file-agent:18082/task` | 契约散落在路由；无 adapter；无生命周期/TTL；无法切换后端 |
| 4 | Agent Runner | 不存在；状态由前端从 NDJSON 流推断 | 无服务端 job 实体；无超时/重试/失败编排 |
| 5 | Job Event Stream | 事件类型散落（agent_tool/agent_text/agent_result/artifacts/done/agent_error），前端 `runFileTask` 手写解析 | 无服务端状态机（queued→creating→uploading→analyzing→reading→planning→editing→generating→done/failed） |
| 6 | Artifact Service | `app/api/artifacts/create` + `[id]` + 磁盘 `manifest.json`（`lib/` 层无实体） | 只有 create/download；无 job 绑定、无过期、无 preview 元数据、无对象存储抽象 |
| 7 | Vision Preprocessor | `lib/vision.ts` 已有（MiniMax，UNTRUSTED 标记，`describeImageBase64` + `buildVisualContextBlock`） | 已有，但输出只是文本块；结构化字段（summary/visible_text/layout/...）未持久化进 workspace |
| 8 | File Processor | `files/upload` 有扩展名白名单、大小/数量限制、`safeName`、路径检查 | 无 ZIP 解压（zip slip！）、无 symlink 限制、无内容解析入 workspace 元数据 |
| 9 | Chat Renderer | `components/message/MessageParts` + `lib/message/types.ts`（parts 判别联合已有 text/reasoning/artifact/attachment/tool_status） | parts 模型已接近 AI SDK；缺 job 事件渲染、artifact 卡片丰富化 |
| 10 | Persistence | 对话在 localStorage；job 状态无；artifact 在磁盘 | 需分清 local profile / server job state / artifact storage / conversation history |

结论：**不需要推翻重写**。`lib/vision.ts`、`lib/message/types.ts`、`lib/toolRegistry.ts`、artifact 雏形都可保留，重点是**把散落的路由内逻辑收敛为模块、补上缺失的抽象层与状态机**。

---

## 二、总体分层

```text
┌─────────────────────────────────────────────────────────────┐
│  网页入口（Next.js app，Vercel）                              │
│  page.tsx / components/  →  Chat Renderer + Job UI + Artifact Card │
├─────────────────────────────────────────────────────────────┤
│  API 层（Route Handlers）                                    │
│  /api/chat · /api/tasks · /api/artifacts · /api/files · /api/vision │
├─────────────────────────────────────────────────────────────┤
│  编排层（lib/ 服务模块，纯 Node 逻辑，可单测）                  │
│  TaskRouter → WorkspaceManager → AgentRunner → JobEventStream │
│  ArtifactService → VisionPreprocessor → FileProcessor → ToolRegistry │
├─────────────────────────────────────────────────────────────┤
│  执行边界（SandboxRuntimeAdapter 背后可切换）                  │
│  当前：Docker 容器 + Claude Code + DeepSeek V4 Flash          │
│  未来：E2B / Modal / Daytona / microsandbox                  │
├─────────────────────────────────────────────────────────────┤
│  存储：WorkspaceStore · ArtifactStore · JobStore · ProfileStore │
└─────────────────────────────────────────────────────────────┘
```

核心原则（来自研究）：
1. **前端与沙箱解耦**（E2B）：前端只持有会话 token，容器生命周期归 Sandbox Service。
2. **事件驱动而非状态散落**（OpenHands）：所有 agent 进展走统一 Job Event Stream，前端增量消费。
3. **workspace 即会话级长期对象**（Daytona）：一个对话一个 workspace，跨消息复用，idle 回收 + snapshot 归档。
4. **artifact 是一等对象**（LibreChat）：绑定 job，携带签名下载 URL，与消息内容解耦。

---

## 三、十大模块定义

### 1. Task Router
**职责**：判断请求类型，输出结构化 `task.type`。输入：user message + attachments(类型/数量) + images + files + 选中 model + settings。输出：`{ type, plan }`。

```ts
type TaskType = "chat" | "artifact" | "agent_workspace";
type TaskIntent = {
  type: TaskType;
  artifactKind?: "pptx" | "html" | "csv" | "zip" | "image";
  needsSandbox: boolean;
  confidence: "high" | "low";
};
```

判定规则（按优先级，全部失败则回退 chat）：
- **显式 artifact**：`做/生成/给我/发` + 文件类型名词（PPT/PPTX/HTML/表格/CSV/图片）→ `artifact`。
- **agent workspace**：附件中有图片/文件，且意图为修改/处理/修复/根据截图 → `agent_workspace`；或纯文本但语义上是「构建项目/改代码/多步执行」→ `agent_workspace`。
- **chat**：其余。

**当前状态**：`isFileTaskPrompt()` 启发式在 `lib/toolRegistry.ts:38`，前端 `page.tsx:516` 硬编码分叉。
**研究参照**：Open WebUI 的「全局 Config × 模型能力」注入、OpenHands 的 `buildStartConversationRequest`。
**改进点**：把路由判断从 `page.tsx` 上收到服务端 `lib/taskRouter.ts`；`task.type` 走一条 `/api/tasks` 入口统一分发；留一个可插拔的「模型辅助分类」钩子（后续用轻量分类模型提升置信度，默认启发式即可）。
**不做**：不在 Router 里做执行；不因一次误判把对话锁死。

### 2. Workspace Manager
**职责**：管理 workspace 生命周期与三类工作区。
- `temporary`：单次任务内的中间产物，任务结束即回收。
- `persistent`：会话级 workspace，一个 conversationId 一个，跨消息复用（Daytona session-reuse 模型）。
- `file-agent`：为沙箱 agent 准备的挂载目录（`.go-ai/` 放任务说明、vision 结果、plan 文件）。

接口：`createWorkspace(convId)` / `materializeWorkspace(convId, jobId, files)` / `storeVisionContext(ws, images)` / `collectOutputs(ws)` / `archiveWorkspace(convId)` / `cleanup(ttl)`。

**当前状态**：`/data/workspaces/<conv>/<job>` 由两个路由各自 mkdir，无生命周期。
**研究参照**：Daytona `sandbox.service.ts` 状态机 + autoStop/autoArchive；E2B `POST /sandboxes` TTL；LibreChat `runtime_session_hint=conversationId`。
**改进点**：引入 `WorkspaceStore` 抽象（本地磁盘 / 对象存储可切换）；workspace 元数据（文件清单、vision 结果、任务 spec）写入 `.go-ai/manifest.json`；会话结束/空闲超时自动归档。
**不做**：不在 Workspace Manager 里跑 agent；不做跨用户共享 workspace。

### 3. Sandbox Runtime（SandboxRuntimeAdapter）
**职责**：把「执行沙箱」抽象成统一接口，第一版实现仍是 Docker + Claude Code + DeepSeek V4 Flash，但契约来自 E2B API 形状，未来可切 E2B/Modal/Daytona。

```ts
interface SandboxRuntimeAdapter {
  create(opts: { image: string; workspace: WorkspaceRef; env: Record<string,string> }): Promise<SandboxHandle>;
  run(handle: SandboxHandle, cmd: { args: string[]; workdir: string; timeoutMs: number; pty?: boolean }): Promise<CommandResult>;
  writeFile(handle, path, content): Promise<void>;
  readFile(handle, path): Promise<Buffer>;
  download(handle, path): Promise<ArtifactRef>;
  destroy(handle): Promise<void>;
}
type SandboxHandle = { id: string; url?: string; token: string; status: "starting"|"running"|"paused"|"error" };
```

**当前状态**：`app/api/agent/task/route.ts` 直接 `fetch(AGENT_URL + "/task")`。
**研究参照**：E2B `NewSandbox→{sandboxID, envdAccessToken}` 两层设计 + `GET/POST /files?path=` + `POST /run`；Modal `claude -p` + pty + workdir + 温沙箱池；microsandbox `exec(cmd,args[])` 禁 shell 拼接。
**改进点**：
- 新增 `lib/sandbox/adapter.ts` + `lib/sandbox/dockerClaudeCode.ts`（第一版实现，封装 go-ai-file-agent 调用，或直接换成 Sandbox Service）。
- 把 `agent/task` 路由改成「先经 Workspace Manager 落 workspace → 再调 adapter → 流式事件转发」。
- 命令一律 `args[]` 数组，不拼接字符串；每个命令带 timeout + rlimit（microsandbox 安全边界）。
- DeepSeek V4 Flash 经 env/secret 注入，不进代码。
**不做**：不自己实现 microVM（当前阶段 Docker 够用）；不在前端暴露容器生命周期。

### 4. Agent Runner
**职责**：把任务交给 agent（当前是 Claude Code），接收 events，处理超时/失败/重试，产出结果。**不直接改 UI**，只输出 Job Events。

接口：`runJob(task: AgentTaskSpec): Promise<JobId>`；内部 `spawnAgent` / `watchAgent` / `finalize`。
- 超时：任务级 `maxTurns` + 时间上限（当前 `maxDuration 900`，路由级 → 移到 Runner 内显式控制）。
- 失败恢复：agent 崩溃/超时 → 标记 `failed` + 保留 workspace + 产出 partial artifacts（LibreChat 的 partial 思想）。
- 多轮：同一 workspace 内跨消息续跑（DaytonaSessionManager 模式）。

**当前状态**：不存在；agent 调用逻辑内嵌在 `agent/task` 路由。
**研究参照**：Modal `sandbox_pool.py`（温沙箱池 + readiness probe）；OpenHands `TaskAction`/子代理；Daytona exec-session 双通道。
**改进点**：新增 `lib/agent/runner.ts` + `lib/agent/jobStore.ts`；job 是持久化实体（非流上临时状态）；Runner 可挂多 agent 类型（`claude-code` / `file-agent` / 未来 code interpreter）。
**不做**：不把 UI 状态写在 Runner；不做任务级并发调度（第一版串行足够）。

### 5. Job Event Stream
**职责**：把 agent 执行过程变成前端可读状态机，**不要把原始 terminal log 直接给用户**。

```ts
type JobStatus = "queued" | "creating_workspace" | "uploading_files" | "analyzing_image"
  | "reading_files" | "planning" | "editing" | "running_check" | "generating_artifact"
  | "done" | "failed";
type JobEvent =
  | { type: "status"; status: JobStatus; message: string }
  | { type: "tool"; name: string; label: string }          // 当前工具名（只读模式）
  | { type: "progress"; percent?: number; detail: string }
  | { type: "artifact"; artifact: ArtifactRef }
  | { type: "result"; summary: string }
  | { type: "error"; code: string; message: string }
  | { type: "done"; exitCode: number };
```

**当前状态**：事件类型散落，前端 `runFileTask` 手写解析。
**研究参照**：OpenHands `action_id→observation` 事件模型 + `use-event-store` 增量消费；Vercel AI SDK part 级增量事件；Daytona `PollJobs` 长轮询。
**改进点**：新增 `lib/job/events.ts`（纯类型 + 序列化）+ 服务端 job 状态持久化；wire 格式沿用当前 NDJSON（`application/x-ndjson`），但事件类型收敛为上面 union；前端改为订阅驱动渲染。
**不做**：不直接把 agent stdout 透传；不做 WebSocket（SSE/NDJSON 够用）。

### 6. Artifact Service
**职责**：artifact 是一等对象。create / store / download / preview / expire / link-to-job-and-message。

```ts
type Artifact = {
  id: string; name: string; mime: string; size: number;
  kind: "pptx" | "html" | "csv" | "zip" | "image" | "file" | "pdf";
  jobId?: string; messageId?: string; conversationId?: string;
  createdAt: number; expiresAt?: number;
  preview?: { html?: string; pending?: boolean };        // 延迟预览状态
};
```

**当前状态**：`artifacts/create` + `[id]` + 磁盘 `manifest.json`；无 job 绑定、无过期、无 preview。
**研究参照**：LibreChat `/code/download/:session_id/:fileId` + JWT 短时效 URL + `pending→ready` 延迟预览；E2B `downloadUrl(path)` 签名；LobeChat artifact Portal 渲染解耦。
**改进点**：新增 `lib/artifacts/`（store + registry + url 签名）；下载 URL 带短期签名 token；artifact 挂 jobId（生命周期归属）+ messageId（渲染归属）；office/HTML 支持 `pending→ready` 预览状态；提供过期回收。
**不做**：artifact 存储先用本地磁盘 + 对象存储适配器接口；不做计费/审计。

### 7. Vision Preprocessor
**职责**：图片 → MiniMax → 结构化视觉上下文 → workspace / task context。输出字段：`summary / visible_text / layout / ui_elements / important_details / uncertainty`。视觉内容一律标记 **UNTRUSTED VISUAL CONTEXT**。

**当前状态**：`lib/vision.ts` 已完整实现（`describeImageBase64` + `buildVisualContextBlock`），agent/task 路由里已有 workspace 图片扫描 → `.go-ai/vision/*.md`。
**研究参照**：无需外部参照，本项目已是参照级；只需形式化。
**改进点**：把「扫描 workspace 图片并写 vision 文件」从 `agent/task` 路由抽到 `lib/vision/workspaceScanner.ts`；结构化字段以 JSON 存 `.go-ai/vision/*.json` + markdown 摘要并存；vision 结果作为 task context 传入 Agent Runner。
**不做**：不做多轮视觉对话；不做 OCR（扫描 PDF 仍需外部 OCR）。

### 8. File Processor
**职责**：解析、限制、入 workspace。处理文本文件 / Markdown / CSV / JSON / ZIP / HTML 项目。
- 文本类：大小/数量限制、编码处理（当前已有上限）。
- ZIP：**zip slip 防护**（条目路径必须落在目标目录内）、大小限制、条目数量限制、symlink 限制（拒绝/剥离 symlink 条目）。
- HTML 项目：识别 index.html + 资源相对路径，作为「项目 workspace」入口。

**当前状态**：`files/upload` 已有扩展名白名单 + 20MB/20 个限制 + `safeName` + 路径前缀检查；**无 ZIP 解压**。
**研究参照**：microsandbox `openat2 RESOLVE_BENEATH` 防路径穿越；LibreChat 文件名 sanitize + 文件 ACL。
**改进点**：新增 `lib/files/zip.ts`（安全解压）；统一 `lib/files/processor.ts`；上传入口从「写盘」升级为「解析 → 写入 workspace 并登记 manifest」。
**不做**：不执行上传文件里的任何脚本；不做跨用户文件共享。

### 9. Chat Renderer
**职责**：普通聊天呈现：reasoning / final answer / markdown / KaTeX / table / code / artifact card / **job 状态卡**。Renderer 不负责业务判断。

**当前状态**：`components/message/MessageParts` + `lib/message/types.ts` parts 判别联合（text/reasoning/artifact/attachment/tool_status）已具备。
**研究参照**：Vercel AI SDK UIMessage parts + part 级增量；assistant-ui runtime/part 订阅；LibreChat Attachment 卡片路由 + `pending→ready`；LobeChat artifact Portal + thinking 折叠。
**改进点**：补 job 事件渲染（`components/job/JobCard`：状态机进度、当前工具、artifact 卡片）；artifact 卡片支持按 kind 路由预览；tool_status part 升级为 job part。
**不做**：Renderer 不做任务路由；不做图片生成器（那是 Artifact Service 的事）。

### 10. Persistence
**职责**：分四层，不要全塞 localStorage：
- `local profile`：个性化/设置/我的 Skills（现 `localStorage`，保留）。
- `server job state`：job + 事件流（服务端 jobStore，第一版可内存 + 磁盘 JSON，后续对象存储/DB）。
- `artifact storage`：文件本体 + manifest（本地磁盘 → 对象存储适配器）。
- `conversation history`：现状 localStorage；**多用户/长期**演进时迁移到服务端。

**当前状态**：对话 + 设置全在 localStorage；artifact 在磁盘 manifest。
**研究参照**：E2B 沙箱存储会话；Daytona snapshot 归档；LibreChat storage_session_id 对象存储桶。
**改进点**：引入 `lib/storage/` 三个 Store 接口（WorkspaceStore/ArtifactStore/JobStore），本地实现 + 可切换适配器；明确「哪层属于客户端、哪层属于服务端」。
**不做**：第一版不引数据库；不做用户账号体系。

---

## 四、三条运行链路

### A. 普通聊天链路
```
User → Task Router: chat
     → /api/chat（模型流，4 协议 NDJSON）
     → Message Parts（text / reasoning / artifact / tool_status）
     → Chat Renderer → History(localStorage)
```
改动最小：Router 判定为 chat 时行为不变。

### B. 文件生成链路（Artifact Task）
```
User: “做两页 PPT”
→ Task Router: artifact(pptx)
→ Artifact Generator（服务端 pptxgenjs 之类，纯 Node，无需沙箱）
→ 生成 .pptx → Artifact Service（store + registry + 签名下载 URL）
→ Message with Artifact Card（可预览/下载）
```
关键：**确定性文件生成不走沙箱**。PPTX/CSV/简单 HTML 由生成器直接产出（Phase E）。只有「需要读文件/跑代码/迭代修改」才进 Agent 链路。这条链路直接根治「复制到 PowerPoint」——生成器产出的就是文件。

### C. 云端 Agent 链路（Agent Workspace Task）
```
User + files/images
→ Task Router: agent_workspace
→ Workspace Manager（create 会话级 workspace；materialize 上传文件）
→ Vision Preprocessor（workspace 图片 → UNTRUSTED 结构化上下文 .go-ai/vision/）
→ File Processor（文本/CSV/ZIP 安全解压入 workspace）
→ Agent Runner（建 job；写任务 spec .go-ai/task.md；超时/重试）
→ Sandbox Runtime Adapter（Docker 容器 + Claude Code + DeepSeek V4 Flash）
     ├─ read files → edit files → run checks → generate outputs
     └─ 事件经 Job Event Stream 回传（queued→creating→uploading→analyzing→reading→planning→editing→running_check→generating→done/failed）
→ Artifact Service（产物从 workspace 拷贝为 artifact，绑定 job）
→ UI：JobCard（状态机）+ Artifact Card
```

---

## 五、十个关键问题的回答

1. **Go AI 应该更像 OpenHands，还是更像 E2B/Code Interpreter，还是两者结合？**
   **结合，但分层**：向 **E2B** 学「控制面 API + 沙箱内 agent」的两层 Sandbox Service 边界；向 **OpenHands** 学「action/observation + 事件流」的 Job Event Stream 协议；向 **LibreChat** 学 artifact 交付与延迟预览。不要做完整的 OpenHands 平台——Go AI 是「网页入口 + 编排」，不是又一个 agent 框架。

2. **Go AI 当前 Claude Code + DeepSeek V4 Flash 应该放在哪一层？**
   放在 **Sandbox Runtime 层**（SandboxRuntimeAdapter 的第一版实现），在沙箱容器内以无头模式运行（`claude -p`，Modal 模式）。它只是 Agent Runner 可调用的一种 agent，模型经 env/secret 注入，未来可换。

3. **用户上传文件后，文件应先进入哪里？**
   先进 **Workspace Manager 的会话级 workspace**（服务端，`.go-ai/` 下登记 manifest），任务开始时再 materialize 进沙箱（LibreChat `primeFiles` + E2B `files.write` 模式）。不直接给沙箱宿主路径。

4. **图片视觉结果应如何进入 Agent？**
   经 **Vision Preprocessor** 转成结构化上下文（summary/visible_text/layout/ui_elements/important_details/uncertainty），标记 **UNTRUSTED VISUAL CONTEXT**，写入 workspace `.go-ai/vision/`，作为任务上下文注入 Agent Runner；同时保留注入普通聊天的文本块。当前 `lib/vision.ts` 已实现，只需形式化 + 从路由抽离。

5. **PPTX 这类文件应走 Chat，Artifact，还是 Agent？**
   **走 Artifact Task**（服务端生成器直接产出），不走 chat 文本、不进沙箱。只有当生成需要「读用户文件/迭代修改/跑代码」时才升级为 Agent 链路。

6. **普通聊天和云端 Agent 的边界在哪里？**
   在 **Task Router**。判定维度：是否有文件/图片附件、意图是否「修改/处理/生成文件」、是否显式要文件。chat = 模型直答（流式 parts）；artifact = 确定性生成；agent_workspace = 需要工具/沙箱的多步执行。边界规则在 `lib/taskRouter.ts`，单一决策源，前端只消费。

7. **Sandbox 是否应该每次任务临时创建，还是按会话保留？**
   **按会话保留（长期 session workspace）**：一个 conversationId 一个 workspace，会话内跨消息复用（Daytona `DaytonaSessionManager` 模式），idle 超时 autoStop + snapshot 归档，新会话才新建。避免每任务冷启动与上下文丢失。

8. **Artifact 应该绑定 message，还是绑定 job，还是两者都绑定？**
   **两者都绑定**：artifact 是持久化一等对象，`jobId` 负责生命周期/清理/过期，`messageId` 负责渲染归属，`conversationId` 负责会话维度检索。下载用短期签名 URL（LibreChat JWT 模式）。

9. **如何避免模型继续回答「你可以复制到 PowerPoint」？**
   三层：① 系统提示明确「Go AI 直接产出文件，不输出复制指令」；② **Task Router 拦截**——artifact/agent 意图请求不进纯 chat，直接进生成/agent 链路；③ 兜底——chat 回复若检测到「复制到/粘贴到/另存为」+ 用户意图是文件，前端提示「正在为你生成文件」并重路由。根治靠 ②（根本不走会这么回答的路径）。

10. **Go AI 最小可行的新架构应该是哪几块？**
    十块，但最小闭环是：**Task Router + Workspace Manager + SandboxRuntimeAdapter + Agent Runner + Job Event Stream + Artifact Service**（前端 Job UI 与 Chat Renderer 在现基础上增量）。Vision/File 预处理是增强，Persistence 是横切。

---

## 六、关键设计决策（带研究依据）

| 决策 | 结论 | 依据 |
|---|---|---|
| 前端是否持有 Docker | 否，抽独立 Sandbox Service | E2B 两层设计；Vercel serverless 无法持有容器 |
| 沙箱生命周期 | 会话级长期 workspace + idle 回收 + snapshot 归档 | Daytona session-reuse + autoStop |
| 事件协议 | NDJSON 状态机事件（非原始 log、非 WebSocket） | OpenHands 事件模型 + 现 `agent/task` NDJSON 基础 |
| 命令安全 | `exec(args[])`、每命令 timeout/rlimit、egress 默认 deny、密钥 host 侧注入 | microsandbox 三层边界 |
| 工具权限 | 统一 Tool 抽象 + 四层门控 + 参数白名单 | Open WebUI `utils/tools.py` |
| 文件安全 | 白名单 + 大小限制 + ZIP zip-slip 防护 + symlink 剥离 | microsandbox openat2、LibreChat sanitize |
| Artifact 交付 | 一等对象 + job 绑定 + 签名 URL + 延迟预览 | LibreChat `pending→ready` + E2B downloadUrl |
| 执行体 | 首版 Docker + Claude Code + DeepSeek V4 Flash，Adapter 隔离 | Modal `claude -p` 模式 |
