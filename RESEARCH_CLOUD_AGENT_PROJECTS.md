# 云端沙箱智能体项目研究报告（Go AI 方向修正）

> 研究日期：2026-08-13
> 目的：为 Go AI 从「聊天客户端」演进为「网页入口 + 云端沙箱智能体 + 文件系统 + 图片理解 + 文件生成/编辑 + Artifact 交付」的 **Cloud Agent Workspace** 提供实现依据。
> 方法：浅克隆到 `D:\codex\research-cloud-agent\repos`，逐项目读真实源码（非 README），输出代码路径与可借鉴点。
> 结论先行：Go AI 应**以 E2B 的 API 形状定义 Sandbox Service 边界、以 OpenHands 的 action/observation 事件模型定义 Job Event Stream、以 LibreChat/Open WebUI 的 artifact 交付与工具门控定义前端与权限层**；主沙箱执行体仍沿用「Docker 容器 + Claude Code + DeepSeek V4 Flash」，但必须从 API 路由中抽离为独立 Adapter。

---

## 一、OpenHands

### 1. 它解决的核心问题
自托管「开发者控制中心」：用统一 UI 驱动 OpenHands / Claude Code / Codex 等 agent（ACP 子进程或直连 LLM），在本地 / Docker / 云端沙箱执行，管理对话、终端、文件、任务列表，并支持 schedule / webhook 无头自动化。

> 版本注意：本次克隆的是最新版 **Agent Canvas（v1.13.0）**，为 TypeScript/React 前端 + agent-server 客户端；经典 Python 后端（`agent_controller`/`EventStream`/`openhands/runtime/`）已独立到 `software-agent-sdk` 仓库。本报告对前端协议层的分析基于本地真实代码；Python 运行时的文件路径来自其公开演进，未逐一取证。

### 2. 与 Go AI 需求的对应关系
- 图片理解：`Message.content` 含 `ImageContent{image_urls}`，图片与文本同帧发送（`base/event.ts`）。
- 文件上传：`conversation-file-upload.api.ts` → `RemoteWorkspace.fileUpload`（并发 5）；`workspace-upload-path.ts` 用 `GET /api/file/home` 锚定相对路径（spec WUP-001）。
- 文件编辑：`FileEditorAction`（view / create / str_replace / insert / undo_edit）→ `FileEditorObservation`（返回 old/new_content、prev_exist）。
- PPT / HTML / ZIP 生成：本质是 `ExecuteBashAction` + 文件写盘 + `GET /api/file/download` 下载。
- 云端 workspace/sandbox：`SandboxStatus`(STARTING/RUNNING/PAUSED/ERROR) + `sandbox_id` + pause/resume。
- artifact 下载：`runtime-service` 的 `downloadFile`（`/api/file/download`）。
- 多轮任务：WebSocket 长连 + `resend_mode='since'` 增量恢复；子代理 `TaskAction`。
- 前端任务状态：`TaskTrackerObservation.task_list` → `use-task-list.ts` + `task-list-tab.tsx`。

### 3. 核心运行逻辑
```
用户请求 → buildStartConversationRequest(agent_settings+workspace+initial_message+confirmation_policy)
→ POST /api/conversations 建会话（cloud 走 /api/v1/app-conversations，轮询到 READY）
→ WebSocket /sockets?resend_mode=since&after_timestamp= 发送 {role:user, content, run:true}
→ LLM 出 ActionEvent（含 thought / security_risk）
→ 沙箱执行出 ObservationEvent（source:"environment"，挂 action_id）
→ 事件推回前端 → 去重/排序 → 用 observation 替换 action 渲染
```

### 4. 关键代码路径（实际看过）
- backend / API entry：`src/api/agent-server-adapter.ts`（buildStartConversationRequest）；`src/api/conversation-service/agent-server-conversation-service.api.ts`；`src/api/event-service/event-service.api.ts`。
- sandbox / runtime：`src/api/runtime-service/agent-server-runtime-service.ts`（execute_bash_command / file / download）；`src/api/cloud/sandbox-service.types.ts`。
- tool / action 执行：`src/types/agent-server/core/base/action.ts`；`src/services/actions.ts`。
- file handling：`src/api/conversation-file-upload.api.ts`；`src/api/workspaces-service/workspaces-service.api.ts`。
- artifact / download：`runtime-service` 的 `downloadFile`；`agent-server-conversation-service.api.ts` 的 `downloadConversation`。
- frontend 状态渲染：`src/routes/task-list-tab.tsx`；`src/stores/conversation-state-store.ts`；`src/stores/security-analyzer-store.ts`。
- state / event stream：`src/contexts/conversation-websocket-context.tsx`；`src/utils/handle-event-for-ui.ts`；`src/types/agent-server/core/events/*`。

### 5. Go AI 可直接学什么
- **可直接借鉴**：action/observation 判别式类型体系（`kind` 字符串 union，每种 action 对应 observation）；`action_id→observation` 关联 + 前端「observation 替换 action」渲染法；事件流去重 + 流式 delta 合并；`X-Session-API-Key` 会话鉴权；`/api/file/home` 锚定上传相对路径。
- **需改造**：WebSocket 全量事件流 → Go AI 用 SSE/NDJSON 即可；`confirmation_policy`+`security_analyzer` 分级确认可先简化；ACP 子进程 JSON-RPC 驱动 Claude Code → Go AI 已是 Docker 内跑 Claude Code，直接对应但无需 ACP 协议。
- **不适合**：本地无沙箱直跑宿主（官方明确警告）；庞大前端 / 多后端注册机制。

### 6. 对 Go AI 的架构启发
- **Job Event Stream**：把「对话/任务」做成持久化事件列表（id/timestamp/source），前端只增量消费——Go AI 应建统一的 Agent Job 事件流（user message → action → observation → status），而非现在散落的状态字符串。
- **Sandbox Runtime Adapter**：`conversation_url`+`session_api_key` 把「会话」与「沙箱运行时」解耦——Go AI 的 Task Router 应对接一个 Runtime Adapter 抽象，统一 bash / 文件 / 下载三类操作。
- **确认/安全分层**：NeverConfirm / ConfirmRisky / AlwaysConfirm + risk 标注是现成的安全边界模型，Go AI 的 sandbox 层可仿此做命令分级放行。
- **workspace 即产物**：文件上传/编辑/下载都以工作目录为锚；PLAN.md 这类「规划文件」用专用 editor action 读写——Go AI 可把任务计划持久化为 workspace 内文件供前端轮询展示。

---

## 二、E2B

### 1. 它解决的核心问题
把「AI 生成的不可信代码」放进云端隔离沙箱执行，并把进程、文件系统、网络以**可编程 API**暴露给 AI 应用。核心抽象是 `Sandbox`：一次创建、按 TTL 存活、可跑命令/写文件/开端口，结束时销毁。真正隔离靠 microVM（Firecracker），Docker 镜像只是模板来源——infra 在独立仓库 `e2b-dev/infra`，本仓库是 API 契约（`spec/openapi.yml`、`spec/envd/`）与 JS/Python SDK、CLI。

### 2. 与 Go AI 需求的对应关系
- 网页入口：SDK `getHost(port)` 把沙箱内任意端口映射成公网 URL（`${port}-${sandboxId}.${domain}`），可直接挂进 Go AI 网页客户端。
- 云端执行：`commands.run()` 跑任意 shell；文件系统：`sandbox.files`（read/write/list/makeDir/remove）。
- 图片理解：上传图片 → 跑 Python/CLI 处理 → 下载结果，全在 `files` 层覆盖。
- 文件生成/编辑：`files.write` / `files.read`。
- Artifact 交付：`downloadUrl(path)` 生成下载链接（`sandbox/index.ts:799`）——这就是 artifact 的本质。

### 3. 核心运行逻辑
```
AI app(SDK) → Sandbox.create(template,{timeoutMs,envs,metadata}) → POST /sandboxes
→ 控制面起 microVM，返回 {sandboxID, envdAccessToken, domain}
→ SDK 用 envdAccessToken 直连沙箱内 agent(envd)：https://{envdPort}-{sandboxId}.{domain}
→ files.write / commands.run（gRPC process.proto Start 流式跑 /bin/bash -lc cmd）
→ CommandHandle 聚合 stdout/stderr/exitCode
→ 产物 files.read 下载 → kill() DELETE /sandboxes/{id} 销毁；TTL 到期自动 kill/pause
```

### 4. 关键代码路径（实际看过）
- API 契约：`spec/openapi.yml`（sandbox 生命周期全部 endpoint）；`spec/envd/envd.yaml`（沙箱内 envd HTTP API）。
- sandbox/runtime：`spec/envd/envd.yaml`（`/init` 注入 accessToken/volumeMounts、`/freeze`/`/fsfreeze` cgroup 暂停）；模板即 Dockerfile：`templates/base/e2b.Dockerfile`。
- command execution：`packages/js-sdk/src/sandbox/commands/index.ts:382` `run()`、`commandHandle.ts`；protobuf `spec/envd/process/process.proto`（`Start`/`Connect`/`SendSignal`，`DataEvent{stdout|stderr|pty}`/`EndEvent{exit_code}`）。
- file handling：`packages/js-sdk/src/sandbox/filesystem/index.ts`（`read:398`、`write:588`、`list:829`）；`spec/envd/filesystem/filesystem.proto` + HTTP `envd.yaml:164 /files`（下载 GET / 上传 POST，`path`、`username` 作 query 参数）。
- artifact/download：`sandbox/index.ts:747 uploadUrl()` / `:799 downloadUrl()`；签名在 `sandbox/signature.ts`。
- state/event：命令/PTY 走 gRPC server-streaming（KeepAlive）；目录 `watchDir` 流式；日志 `GET /v2/sandboxes/{id}/logs`。

### 5. Go AI 可直接学什么
- **可直接借鉴（API 形状）**：`POST /sandboxes` 请求体 `NewSandbox{templateID,timeout,envVars,metadata,network}`；响应 `{sandboxID,envdAccessToken}`；`DELETE /sandboxes/{id}`；TTL 驱动生命周期；`/sandboxes/{id}/connect` 重连续期。**「创建即返回连接凭证、SDK 直连沙箱」的两层设计**（控制面 API + 沙箱内 agent）非常值得照抄。
- **需改造**：文件传输直接照 envd 的 `GET/POST /files?path=`，别用 gRPC；命令执行若不做流式可退化为 `POST /run` 同步返回 `{stdout,stderr,exitCode}`。
- **不适合**：microVM（Firecracker）方案（pause/fork/内存快照/egress 代理）太重；细粒度 egress 过滤、IAM、MCP gateway 暂不需要。

### 6. 对 Go AI 的架构启发
拆三层：① Go AI 前端（Vercel Next.js）只做 UI 与 artifact 展示；② 一个**轻量 Sandbox Service**（自写，Node/Go 均可），管理 Docker 容器，暴露 REST：`/sandboxes`(POST/GET/DELETE)、`/sandboxes/:id/files`(GET/POST)、`/sandboxes/:id/run`、`/sandboxes/:id/ports`；③ 容器内 agent 或直接用 docker exec。模板预装工具链 = 维护几个预构建 Docker 镜像（对应 E2B 的 `templates/base/e2b.Dockerfile`）。

> **核心判断：选 B（借鉴 E2B API 设计自建简化版 sandbox service），不选 A（让 Go AI 前端自己维护 Docker）。**
> 理由：Go AI 跑在 Vercel serverless，本身无法直接持有 Docker；A 会让前端与容器生命周期耦合、无法横向扩容、且把 API key 暴露给前端。正确做法是把「沙箱管理」抽成独立服务（自托管到有 Docker 的 VPS/边缘节点），前端只持有会话 token。隔离层面 Docker 对单租户 workspace 够用（E2B 的 microVM 是为多租户不可信代码准备的，当前阶段可放弃）；但要在沙箱内跑 envd 类 agent 进程，暴露文件与命令 API，TTL/清理必须由服务端强制。E2B 的 endpoint 命名与 request/response 结构可直接作为 OpenAPI 蓝本。

---

## 三、Modal Sandbox（Claude Code 示例）

### 1. 它解决的核心问题
把交互式编码智能体（Claude Code / OpenCode）搬进云端隔离沙箱：沙箱提供镜像环境 + 网络隔离 + 超时，可安全执行任意代码、访问仓库，任务结束可取回输出。两条路径：A) 无头一次性执行——`claude -p "prompt"` 跑完即读 stdout；B) 常驻 server——`opencode serve` 在沙箱内起服务，用加密隧道暴露 WebUI/TUI。

### 2. 与 Go AI 需求的对应关系
- 云端容器跑 Claude Code：`sandbox_agent.py` 用 Image 安装 Claude（换模型只需改 Secret/环境变量指向 DeepSeek）。
- workspace/仓库进沙箱：运行时 `sandbox.exec("git","clone",...)` 到 `/repo`；或构建期克隆进镜像 `clone_github_repo()`。
- 网页入口 + Artifact 交付：`encrypted_ports` + `sandbox.tunnels()[port].url` 浏览器直达。
- 任务说明传入：无头用 CLI 参数（`claude -p`）；server 形态用带口令的会话。
- 任务状态回传：`computer_use_vnc.py` 的 `start_session` 返回 `{sandbox_id, watch_url}`，前端轮询状态路由，agent 退出即 `sandbox.terminate()`。

### 3. 核心运行逻辑
```
app → 定义 Image（debian_slim + curl + "claude install.sh | bash"）
→ modal.Sandbox.create(app, image)
→ sandbox.exec("git","clone","--depth","1",repo,"/repo").wait()
→ sandbox.exec("claude","-p",task, pty=True, secrets=[...], workdir="/repo").wait()
→ 读 ContainerProcess.stdout/stderr → 一次性场景结束
（server 场景：opencode serve + tunnels()[4096].url + 轮询探活）
```

### 4. 关键代码路径（实际看过）
- `13_sandboxes/sandbox_agent.py`：Claude Code 全链路（48 行 git clone、62-70 行 `pty=True` 必需、74-79 行读输出）。
- `13_sandboxes/opencode_server.py`：`define_base_image`(39)、`clone_github_repo`(66)、`add_modal_access`(90 注入 Modal 凭据)、`create_sandbox`(125 `encrypted_ports`+`secrets`+`workdir`)、`print_access_info`(159 隧道 URL)。
- `13_sandboxes/sandbox_pool.py`：`add_sandbox_to_queue`(139)、`readiness_probe=modal.Probe.with_exec`(149)、`claim_sandbox`(218) **温沙箱池化复用**。
- `13_sandboxes/codelangchain/agent.py`：`run()`(69) 封装 `sb.exec("python","-c",code)`，生成→执行→评估→重试循环。
- `13_sandboxes/safe_code_execution.py`：多语言 `exec` + stdout 迭代器流式输出（82-96）。
- `13_sandboxes/cua/computer_use_vnc.py`：异步 `Sandbox.create.aio`、env 传任务、状态回传模式。

### 5. Go AI 可直接学什么
- **可直接借鉴**：Image 安装 agent（install.sh）、`exec` + `pty=True` + `workdir` 跑无头 Claude、`ContainerProcess.wait/stdout/stderr` 取结果、`encrypted_ports`+`tunnels()` 暴露 WebUI、`Secrets` 传 DeepSeek key、`sandbox_pool.py` 的**温沙箱池 + readiness probe**。
- **需改造**：构建期克隆固定 repo → Go AI 需按会话动态挂 workspace（运行时 clone 或 Volume/文件快照）；claude/opencode 模型端点改为 DeepSeek。
- **不适合**：Harbor 评测框架、专有 demo 镜像、notebook 场景。

### 6. 对 Go AI 的架构启发
拆四层：(1) **编排层**——「创建沙箱→下发任务→轮询→回收」，状态经 Queue/Dict 回传；(2) **沙箱层**——独立 app 承载 Sandbox，统一 image（含 Claude Code + DeepSeek secret），支持 `Sandbox.from_id` 恢复与超时终止；(3) **文件层**——进：git clone / Volume 挂载；出：stdout / 隧道下载 / Volume 持久化产物（Artifact）；(4) **接入层**——同时暴露「任务 API + 隧道 URL」，前端轮询状态路由，天然满足「网页入口 + 云端沙箱 + 文件系统 + 文件生成/编辑 + Artifact」目标。

---

## 四、Open WebUI（Tool Server / Tools）

### 1. 它解决的核心问题
同时支撑「自研 Python 插件工具」「外部 OpenAPI Tool Server」「MCP 服务器」「内置文件/知识库/代码解释器」四类工具来源，以统一 OpenAI `tools` schema 注入任意模型。三个核心问题：(a) 统一注册与发现——所有来源收敛成 `{function_name:{callable,spec,type,tool_id}}` 字典；(b) 权限与作用域隔离——工具受「全局开关 + 模型能力 + 用户/角色权限 + access_grants」四层门控；(c) 执行沙箱化——受限 import、外挂 Jupyter、只开放虚拟知识库 FS 不暴露真实磁盘。

### 2. 与 Go AI 需求的对应关系
- Tool Registry：`utils/tools.py` 的 `get_tools()` / `get_builtin_tools()`，注册中心样板。
- 文件系统：`tools/knowledge_fs.py` 的 `kb_exec()`（虚拟 FS：`ls/cat/grep/find/sed/tree` + 管道）正是 Go AI 要的「沙箱文件系统」。
- 图片理解：上传后 `process_uploaded_file`（`routers/files.py:128`）多模态原样存储；`view_file` 喂给模型。
- 文件生成/编辑：`write_note`/`replace_note_content` 与 `edit_image` 示范「写文件→回传」。
- Code interpreter：`execute_code`，可走 pyodide(前端) 或外接 Jupyter。
- Artifact 交付：`process_tool_result`（`utils/middleware.py:871`）把 `HTMLResponse`/`data:image` 转成 `embeds`/`files` 回传前端。
- 权限模型：`utils/access_control/__init__.py` 的 `has_permission/has_access/has_connection_access`。

### 3. 核心运行逻辑
```
用户 chat → process_chat_completion（utils/middleware.py）
1. 解析 tool_ids（模型 meta 绑定 / 用户选择），server:mcp: 前缀走 MCP 会话，其余查 DB
2. get_tools() 按 tool_id 查库 → load_tool_module_by_id（exec 动态加载源码）
   → 用 functools.partial 注入 __user__/__files__/__metadata__ 隐藏参数
3. get_builtin_tools() 按「全局 Config × 模型 capabilities × 用户权限」逐类注入
4. 所有 spec 经 convert_function_to_pydantic_model → OpenAI schema 压入 tools
5. 模型返回 tool_calls 后，while 循环逐轮执行（上限 max_tool_call_iterations）：
   execute_tool_call 校验参数白名单 → callable(**params)
   → process_tool_result 归一化（HTML→embed、base64 图→file）
   → function_call_output 追加回对话流再喂模型
```

### 4. 关键代码路径（实际看过）
- 注册中心：`backend/open_webui/utils/tools.py`（`get_tools` L267、`get_builtin_tools` L520、`convert_function_to_pydantic_model` L860、`execute_tool_server` L1553）。
- 内置工具：`backend/open_webui/tools/builtin.py`（`execute_code` L496、`view_file` L2588、`search_web` L282、`write_note` L1149、`edit_image` L423、`_has_read_access_to_file` L97）。
- 虚拟文件系统：`backend/open_webui/tools/knowledge_fs.py`（`kb_exec` L1125、`_resolve_file` L438、`_execute_pipeline` L1093）。
- MCP 接入：`backend/open_webui/utils/mcp/client.py`（`MCPClient.connect/list_tool_specs/call_tool`）。
- 文件上传/处理：`routers/files.py`（`upload_file_handler` L315、`process_uploaded_file` L128）。
- 编排/权限：`utils/middleware.py`（`process_chat_completion`、`add_file_context` L1570、`process_tool_result` L871、工具执行循环 L4916）；`utils/access_control/__init__.py`（`has_permission` L72、`has_access` L108）。
- 代码执行：`utils/code_interpreter.py`（`JupyterCodeExecuter`，WebSocket 连外部内核）。

### 5. Go AI 可直接学什么
- **可直接借鉴**：四层门控范式（全局 Config → 模型 capabilities → 用户角色/权限 → access_grants）；隐藏参数注入法（`functools.partial` + 删掉 `__` 前缀参数再暴露 schema）；`kb_exec` 单入口字符串命令式虚拟 FS；执行循环的「参数白名单过滤 + 迭代上限 + 结果归一化」。
- **需改造**：内置工具「模型 meta 决定注入哪些」耦合较深 → Go AI 应改为显式 tool 声明；`exec` 动态加载插件无真正沙箱 → 需受限 import 与子进程。
- **不适合**：Jupyter 外挂（多用户并发差）；把大量业务实体（memory/notes/channels）塞进内置工具——Go AI 应保持工具集精简。

### 6. 对 Go AI 的架构启发（MCP / Tool Registry）
- 设统一 `Tool` 抽象：`id / spec(JSON Schema) / invoke(params)`；来源分三类——内置（进程内）、插件（动态加载）、MCP（`mcp` SDK 客户端）；用 `tool_id` 前缀路由（`builtin:` / `server:mcp:` / `server:openapi:`）。
- 文件读写不暴露宿主机路径，做「按会话挂载的虚拟 FS」（`kb_exec` 思路 + 目录树白名单）。
- 模型-工具绑定放模型配置，叠加用户级 `access_grants` 细粒度授权；执行时在 middleware 层统一校验而非每个工具自查。
- 工具返回与「展示」解耦——文本回模型、`data:image`/HTML 转 `files`/`embeds` 给前端，这就是 Artifact 交付雏形。

---

## 五、LibreChat Code Interpreter

### 1. 它解决的核心问题
让模型在受控沙箱里执行代码/命令，并把执行结果（stdout、生成图片、生成文件）以「消息内 artifact 卡片」形式交付给用户，实现从纯聊天到「能干活」的进化。

> 仓库说明：独立服务仓库 `LibreChat-Code-Interpreter-Service` 已迁移/不可访问（克隆 404），无法直接取证其容器实现。主仓库当前已把「代码执行」演进为两代：旧版 `code_interpreter` 工具（OpenAI Assistants 兼容、依赖外部服务）与新版 `execute_code` 沙箱（codeapi，本文重点）。

### 2. 与 Go AI 需求的对应关系
- 上传文件进入执行环境：`primeFiles` 把用户文件 push 进沙箱 `/mnt/data`。
- 文件生成/编辑：`create_file` / `edit_file` 工具（`bash_tool` 之外的第二对工具）。
- 图片理解：`read_file` 对 png/jpg 走 base64 读图路径 `handleSandboxImageRead`。
- Artifact 交付：`AttachmentGroup` 按类型路由成可预览/下载的卡片。

### 3. 核心运行逻辑
```
上传（multer 落盘入库，带 codeEnvRef 元数据）
→ 会话发起时 agent 启用 execute_code capability
→ registerCodeExecutionTools 展开为 bash_tool + read_file 工具定义
→ primeFiles 把用户文件按 storage_session_id 复传到 codeapi 存储会话
→ 模型工具调用 → codeapi /exec（runtime_session_hint=conversationId，有状态会话）
→ 执行器 stdout/stderr 及 artifact.files[] 返回
→ processCodeOutput 从 /download/{session_id}/{id} 拉取生成文件字节、写 DB、挂为消息附件、SSE 推送
→ 前端 Attachment 组件按扩展名路由到 图片/office/mermaid/文本/文件卡片
```

### 4. 关键代码路径（实际看过）
- 工具展开：`packages/api/src/agents/tools.ts:442` `registerCodeExecutionTools`；`CODE_CREATE_FILE_DEF`/`CODE_EDIT_FILE_DEF`。
- 执行与鉴权：`packages/api/src/agents/prewarm.ts`（/exec 预热）；`packages/api/src/auth/codeapi.ts`（JWT）。
- 文件进入沙箱：`api/server/services/Files/Code/process.js:888` `primeFiles`、`:760` `getSessionInfo`。
- 结果回传：`process.js:319` `processCodeOutput`；`controllers/agents/callbacks.js:904`、`controllers/tools.js:174` 处理 `artifact.files`；`StreamRunManager.js:247` `handleCodeImageOutput`。
- 下载：`api/server/routes/files/files.js:317` `/code/download/:session_id/:fileId`。
- 前端卡片：`client/src/components/Chat/Messages/Content/Parts/Attachment.tsx`（路由+下载）、`ToolArtifactCard.tsx`、`Stdout.tsx`（剥离 `Generated files:`）、`Artifacts/Artifacts.tsx`（侧栏 sandpack 预览）。
- 权限：`packages/data-provider/src/permissions.ts` `RUN_CODE`；`controllers/tools.js:26` `directCallableTools`。

### 5. Go AI 可直接学什么
- **可直接借鉴**：前端 artifact 卡片分类路由、延迟预览状态机（`status: pending→ready`）、`useAttachmentLink` 统一下载。
- **需改造**：LibreChat 是单体后端 + 外部 sandbox 服务；Go AI 在 Vercel serverless 无 docker，需把沙箱换成 E2B/Modal/Daytona 类远程沙箱。
- **不适合**：旧 `code_interpreter` 对 OpenAI Assistants API 的深度绑定。

### 6. 对 Go AI 的架构启发（Artifact/文件交付重点）
- 把「生成文件」设计成与聊天记录解耦的持久化对象：codeapi 用 `storage_session_id` 独立存储桶 + JWT 短时效下载 URL，天然适配 Vercel——生成物存对象存储，前端拿签名 URL 预览下载。
- 会话隔离即 `runtime_session_hint`=会话 ID：文件访问按 `kind/id`（用户级）解析 sessionKey，多用户天然隔离。
- 安全三层：文件名 sanitize 防路径穿越、`filterFilesByAgentAccess` 文件 ACL、`RUN_CODE` 权限门控——Go AI 的沙箱工具须同样分层。
- **延迟渲染是关键 UX**：office 文件先发 `pending` 卡片、后台渲染后 SSE/轮询升级为真预览，避免阻塞回复流。

---

## 六、Daytona

### 1. 它解决的核心问题
「云端开发环境即服务」（Sandbox-as-a-Service）。v0.190.0（开源最终版）把传统 workspace 概念重命名为 **sandbox**，面向 AI Agent 提供：按需拉起的隔离 Linux 容器、进程/文件/git 操作 API（toolbox）、环境状态可随时固化为镜像实现跨会话持久化。核心命题是「让远程环境像本地一样可编程、可复用、可回收」。

### 2. 与 Go AI 需求的对应关系
- sandbox 生命周期管理 → Go AI 的 workspace 管理。
- snapshot 持久化 → 跨会话/跨任务保留环境状态。
- toolbox 的 process/fs/git/LSP/computer-use API → 沙箱内执行与文件读写。
- opencode-plugin 的 session-sandbox 复用策略 → 多会话是否复用环境的设计决策。

### 3. 核心运行逻辑
```
客户端（sdk-go / opencode plugin）→ 控制面 API（apps/api，NestJS createSandbox）
→ 选 runner 落库 Sandbox 实体，发 CREATE_SANDBOX job
→ 每台机器的 runner（apps/runner，Go）用 PollerService 长轮询 PollJobs
→ Executor 按 jobType 分派到 DockerClient.Create：PullImage(snapshot 即镜像) → ContainerCreate
   entrypoint 强制 /usr/local/bin/daytona（daemon 二进制 bind-mount 进容器）
→ 容器内 daemon 以 PID1 运行：起 toolbox server、terminal(22222)、SSH、childreap
→ 客户端经 sandbox.toolboxProxyUrl（{proxy}/{sandboxId}）直连 toolbox 做 exec/fs
→ 持久化：commitContainer(docker commit) → PushImage 到 snapshot-manager(内部 OCI registry)
→ 新 sandbox 从该镜像重建；空闲回收靠 autoStop/autoArchive/autoDelete 三档定时器
```

### 4. 关键代码路径（实际看过）
- `apps/api/src/sandbox/services/sandbox.service.ts`：`createFromSnapshot` / `createFromBuildInfo` / `archive` / `start` / `stop` / `destroy` / `createSnapshotFromSandbox`（状态机）。
- `apps/api/src/sandbox/controllers/{sandbox,snapshot,volume}.controller.ts`；`runner-adapter/runnerAdapter.v2.ts`（发 job）。
- `apps/runner/pkg/runner/v2/poller/poller.go`；`executor/executor.go`；`docker/{create,start,stop,destroy,backup,container_commit,snapshot_sandbox}.go`。
- `apps/daemon/cmd/daemon/main.go`；`pkg/toolbox/controller.go`；`pkg/toolbox/process/execute.go`；`pkg/toolbox/fs/*`；`pkg/session/`。
- `libs/sdk-go/pkg/daytona/client.go`（`createToolboxClient` 拼 `{proxyUrl}/{sandboxId}`）；`libs/toolbox-api-client-go/api_process.go`。
- `libs/opencode-plugin/.../core/session-manager.ts`、`tools/bash.ts`、`git/session-git-manager.ts`。

### 5. Go AI 可直接学什么
- **可直接借鉴**：sandbox 状态机（STARTED/STOPPED/ARCHIVED/SNAPSHOTTING…）；job 驱动的 runner 长轮询模型（控制面与执行器解耦）；toolbox 的「同步 executeCommand + 后台 exec-session（runAsync，按 cmdId 追踪）」双通道；fs API 全集（upload/download/search/find-in-files/replace）；snapshot=容器镜像+registry 的方案（实现简单、天然可移植）。
- **需改造**：NestJS 控制面太重（Postgres+Redis+TypeORM+配额/计费），Go AI 只需精简版；warm-pool/GPU/Android/网络白名单等托管特性去掉。
- **不适合**：devcontainer 在 hosted 版基本消失，改用 `buildInfo`（Dockerfile 内容 + contextHashes 上传对象存储）的声明式构建；传统 Daytona CLI 的 provider/workspace 抽象已移除。

### 6. 对 Go AI 的架构启发（workspace 生命周期）
**应选「长期 session workspace」而非「一次任务一个临时 workspace」。** 依据是 opencode-plugin 的 `DaytonaSessionManager`：sessionId→sandboxId 持久化映射存于 `~/.local/share/opencode/storage/daytona/{projectId}.json`；同一 AI 会话内每条消息复用同一 sandbox（`refreshData()` 后 `start()` 续跑），跨消息保留进程、工作目录与未保存文件；新会话才新建 sandbox；会话结束 `deleteSandbox`。git 复用宿主 repo：分配 `opencode/N` 分支 + worktree 与 sandbox 同步。
Go AI 应对每个对话绑定一个 workspace，会话内跨消息复用，配合 idle autoStop + 显式 snapshot 归档供跨会话恢复，而非每任务重建（避免冷启动与上下文丢失）。

---

## 七、microsandbox

### 1. 它解决的核心问题
用**本地 microVM**（libkrun VMM + 自建 guest 内核 libkrunfw，KVM/Hypervisor.framework/WHP，冷启动 <100ms）在硬件隔离边界内运行不可信工作负载（AI agent、用户代码、CI）。核心不是「容器沙箱」而是「微型虚拟机」：无共享内核，容器逃逸类攻击面不存在。强调 Agent-Ready：提供 Agent Skills + MCP server 供 Claude Code/Codex/Gemini CLI 调用。注：实际是 **Rust 项目**（`crates/*`），Python/TS/Go/Ruby SDK 经 FFI（Python 用 PyO3）绑定。

### 2. 与 Go AI 需求的对应关系
- 云端沙箱执行：`Sandbox.exec/shell` + local/cloud 双后端（`MSB_BACKEND=cloud`），可直接作为 Go AI 后端抽象模板。
- 文件系统/文件生成：`Sandbox.fs.read/write/list/copy/copy_from_host` 全量 API 即文件工具 schema 蓝图。
- 持久化：named/bind/tmpfs/disk 四类卷，跨沙箱共享。
- 图片理解/Artifact：不含图片模型能力，但 fs.read 返回字节流 + exec 跑 Python 可组合出「读文件→调视觉模型」链路。
- 结构化工具调用：MCP server 子模块提供标准 tool 定义；协议层为 serde struct + CBOR 帧。

### 3. 核心运行逻辑
```
agent → SDK → fork+exec 启动 msb CLI 子进程（sdk/rust/lib/runtime/spawn.rs::spawn_sandbox，
       读 stdout startup JSON 取 relay socket）
→ 经 virtio-console 发 CBOR 帧到 guest 内 PID1 的 agentd
→ agentd 执行（crates/agentd/lib/process.rs::ProcessManager，exec 请求含 cmd/args/env/cwd/user/tty/rlimits）
→ 以 ExecStarted/ExecStdout/ExecExited 事件流回传 → SDK 聚合为 ExecOutput
→ shell(script) = exec("/bin/sh", ["-lc", script])
→ 超时在 host 侧 tokio::time::timeout → SIGKILL → 5s 宽限
→ 控制通道仅 host 驱动，guest 无法反向操控 host
```

### 4. 关键代码路径（实际看过）
- 协议：`crates/protocol/lib/exec.rs`（`ExecRequest/ExecRlimit`）、`lib/fs.rs`（`FsOp` 枚举，`FS_CHUNK_SIZE=3MiB`）、`lib/core.rs`。
- 隔离：`docs/security/isolation.mdx`（设备面 virtio-console/net/fs/blk/rng，host 进程非特权）。
- 文件系统安全：`crates/filesystem/lib/backends/*`（virtio-fs broker，Linux 用 `openat2 RESOLVE_BENEATH` 防 `..`/symlink 逃逸，readonly 由 host 侧强制）。
- 密钥：`crates/network/lib/secrets/*` + `examples/python/net-secrets/main.py`（guest 只见占位符，host TLS 代理按 allow_hosts 注入）。
- 网络策略：`crates/network/lib/policy/*`，egress 默认 deny。
- SDK 面：`sdk/python/microsandbox/_microsandbox.pyi`（`Sandbox/SandboxFsOps/Volume` 全签名）、`types.py`（`ExecOptions/MountConfig/NetworkPolicy/SecurityProfile`）。

### 5. Go AI 可直接学什么
- **可直接借鉴**：local/cloud 后端 trait 抽象（本地子进程 vs 云端 HTTP 控制面）——Go AI 部署在 Vercel 天然走「远程沙箱服务」分支；exec/fs/volume/lifecycle 这套工具 API 面直接映射为 Go AI 的 tool schema；**密钥占位符 + host 侧 TLS 拦截注入**（比把 key 塞进容器 env 安全得多）；MCP + Skills 双入口。
- **需改造**：Vercel 边缘无法跑 KVM microVM，须把沙箱放到带虚拟化/容器的独立计算（Fly/EC2）；文件读写从 virtio-fs 换成宿主挂载/对象存储。
- **不适合**：为「改个文件」启动整台 VM 过重；Go AI 轻量编辑可先用目录 jail + 白名单命令，再按需升级为 VM。

### 6. 对 Go AI 的架构启发（Bash 安全边界）
开放 Bash 时复制 microsandbox 的三层边界：① **强隔离执行体**（VM 或独立容器，host 进程无特权、无环境变量/宿主机路径透传）；② **host 驱动控制通道**（agent 只能「请求执行」，不能反向连宿主；命令一律 `exec(cmd, args[])`，禁止字符串拼接 shell）；③ **策略外置**（网络 egress 默认 deny + 域名白名单、文件 jail 用 openat2 防穿越、每命令 rlimit+timeout、密钥占位符注入）。四类设备（console/net/fs/blk）即最小攻击面清单。

---

## 八、次级项目（辅助参考，非主参照）

以下三项目只解决 **Chat UI / 消息模型 / 传输协议**，均不提供云端沙箱能力。

### 8.1 Vercel AI SDK（`repos/ai`）
- 核心：`packages/ai/src/ui/ui-messages.ts` 的 `UIMessage = {id, role, metadata, parts}`，parts 是判别联合（Text/Reasoning/Tool/DynamicTool/File/SourceUrl/StepStart），每 part 自带 `state: 'streaming'|'done'`；`UIToolInvocation` 状态机（input-streaming→input-available→output-available/output-error）。传输协议 `ui-message-chunks.ts` + `json-to-sse-transform-stream.ts`：每个 SSE 事件是 JSON（`data:{"type":"text-delta","id":..,"delta":..}`），工具按 tool-input-start/delta/available、tool-output-available/error 分片，`[DONE]` 收尾。
- 启示：消息建模为「part 数组 + 每 part 独立流式状态」，wire 格式即 part 级增量事件，前端按 `type` 分发渲染。Go AI 的 Message Parts 层可直接照搬这套数据模型。

### 8.2 assistant-ui（`repos/assistant-ui`）
- 核心：`packages/core/src/types/message.ts` 的 `ThreadMessage`= role + content(part 数组) + status + metadata；part 含 Text/Reasoning/ToolCallMessagePart（argsText、result、isError、artifact、interrupt/approval）/GenerativeUIMessagePart（JSON 组件树 spec + allowlist 安全边界）。`packages/core/src/types/attachment.ts`：Attachment 分 Pending/Complete 两态，CompleteAttachment 持 `content: ThreadUserMessagePart[]`，**附件即 part 的组合**。Runtime 抽象 `packages/core/src/runtime/api/`：AssistantRuntime→ThreadRuntime→MessageRuntime→MessagePartRuntime，UI 只消费 runtime 接口。
- 启示：UI 只消费 runtime 接口、part 是可订阅状态；附件是 part 组合而非独立模型。Go AI 的 Chat Renderer 参考其双层解耦与 part 订阅状态机。

### 8.3 LobeChat（`repos/lobe-chat`）
- 核心：Artifact 用「markdown 内嵌标签 + 独立 Portal」两条腿——`src/features/Conversation/Markdown/plugins/LobeArtifact/rehypePlugin.ts` 把 `<lobeArtifact>` 标签解析为节点，`Render/index.tsx` 渲染卡片，`src/features/Portal/Artifacts/Body/index.tsx` 按 type 分发到 HTML/SVG/React 渲染器，生成中自动 Code→Preview 切换。Thinking 用 Accordion 折叠 + 自动滚动（`components/Thinking/index.tsx`）。模型层：`packages/model-bank/src/aiModels/*` 每厂商一个声明式文件 + `packages/model-runtime/src/core/ModelRuntime.ts`（chat/generateObject/embeddings 统一接口 + hooks）+ runtimeMap 注册。
- 启示：artifact 卡片与 Portal 渲染解耦、thinking 作为可折叠独立块、模型按厂商声明式注册并统一 runtime——对 Go AI 的 Chat Renderer 与 provider 层有参考价值。

---

## 九、项目→Go AI 模块映射总结

| 项目 | 最值得学 | 落到 Go AI 哪个模块 |
|---|---|---|
| OpenHands | action/observation 事件模型、confirmation 分级、/api/file/home 锚定 | Job Event Stream、Sandbox Runtime Adapter、安全确认层 |
| E2B | 控制面 API + 沙箱内 agent 两层设计、TTL 生命周期、files/run endpoint 形状 | Sandbox Service（SandboxRuntimeAdapter 的目标接口） |
| Modal Sandbox | 无头 `claude -p` + pty + workdir、温沙箱池、隧道暴露 | Agent Runner、Sandbox Runtime Adapter |
| Open WebUI | 四层权限门控、工具注册中心、参数白名单执行循环、kb_exec 虚拟 FS | Tool Registry、权限层、File Processor |
| LibreChat | artifact 卡片路由、pending→ready 延迟预览、JWT 短时效下载、会话隔离 | Artifact Service、前端 Artifact 卡片 |
| Daytona | 长期 session workspace 复用、snapshot=镜像+registry、job 驱动 runner | Workspace Manager、持久化 |
| microsandbox | 三层安全边界、exec(cmd,args[]) 禁 shell 拼接、密钥占位符、egress deny | Sandbox Runtime Adapter、Bash 安全策略 |
| Vercel AI SDK | UIMessage/part 增量事件传输 | Chat Renderer、Message Parts |
| assistant-ui | runtime/part 订阅、附件即 part | Chat Renderer |
| LobeChat | artifact Portal、thinking 折叠块、声明式模型注册 | Chat Renderer、provider 层 |

> 未深入部分：OpenHands 经典 Python 后端（software-agent-sdk，未克隆）、E2B infra（e2b-dev/infra，独立仓库）、LibreChat 独立 code-interpreter 服务（仓库迁移不可访问）。这些影响研究完整性但不断言性结论——Go AI 所需的核心机制已从主仓库取证。
