# V1.5 架构收敛：OpenCode 与 Claude Code 可调用接口审计

> 研究日期：2026-08-16
> 目的：评估 OpenCode / Claude Code 作为"可插拔 specialized executor"的可行性与接入成本，支撑 Go AI V1.5 架构收敛决策。
> 研究方法：npm 包实装（`D:\Projects\go-ai\docs\tmp-sdk-audit\node_modules`）、双 SDK 冒烟测试（实测通过）、GitHub 源码浅克隆（`D:\Projects\go-ai\docs\tmp-sdk-audit\opencode-repo`）、官方文档交叉验证。
> 冒烟测试脚本：`D:\Projects\go-ai\docs\tmp-sdk-audit\smoke-claude-sdk.mjs`、`smoke-opencode-sdk.mjs`（可复跑）。

---

## 0. TL;DR 结论表

| 维度 | OpenCode | Claude Code（Agent SDK / CLI） |
|---|---|---|
| 包/版本 | `@opencode-ai/sdk@1.18.18`（MIT，依赖仅 cross-spawn） | `@anthropic-ai/claude-agent-sdk@0.3.233`（内嵌 320MB 原生 CLI 二进制，8 平台） |
| 对外协议 | **REST HTTP + SSE**（`opencode serve`），`GET /doc` 输出 OpenAPI JSON，另有 WebSocket | SDK 内部 = **stdio JSON-RPC**（spawn CLI + `--input-format stream-json`）；对外官方路径 = CLI 子进程 `-p` 或 TS/Python SDK |
| 进程内嵌入 | ✅ `createOpencode()` 可在一个 Node 进程内起 server + 客户端 | ✅ TS 库 `query()` 进程内跑 loop；Go 只能走 CLI 子进程 |
| Session 管理 | ✅ 完整 REST：create/list/status/fork/abort/revert/share/diff/children/todo/messages | ✅ `resume`/`sessionId`/`continue`/fork/rename/tag/list（JSONL 持久化 + 可插 SessionStore） |
| 一次任务（带工具） | ✅ `POST /session/{id}/prompt_async`（204 异步）+ SSE /event 订阅 + status 轮询 | ✅ `query({prompt, options})` 异步迭代事件直到 result |
| 工具注册 | 插件 `hooks.tool`（zod schema + execute）、MCP 配置；`tools` 字段按名启用/禁用 | `tools` 选项（zod schema）、`mcpServers`、`canUseTool` 权限钩子、`toolAliases` 重定向内置工具 |
| 事件流 | ✅ SSE：40+ Event 判别联合（message/part 增量、session 状态、权限、todo、文件编辑、命令执行） | ✅ 40+ SDKMessage 类型（assistant/tool_use/result/partial/hook/task 进度），流式逐条 |
| API key | 无需 key；provider 凭据在 `~/.local/share/opencode/auth.json` + 配置 | **需要** ANTHROPIC_API_KEY（或 OAuth/Bedrock/Vertex/Foundry）；**ANTHROPIC_BASE_URL 可换自定义端点**（本机实测走中转成功） |
| 模型可换性 | ✅ provider 配置完全开放（Go AI 已配置 zen/go 的 DeepSeek 等） | ⚠️ 官方不鼓励第三方模型；但 ANTHROPIC_BASE_URL + ANTHROPIC_MODEL 可指任意 Anthropic 兼容端点（已实测） |
| 鉴权 | ⚠️ server 默认**无鉴权**（需设 OPENCODE_SERVER_PASSWORD） | 凭证在宿主进程 env（SDK 不透传 key） |
| 官方语言支持 | SDK 是 TS，但协议是纯 HTTP —— **任何语言（含 Go）可直接驱动** | SDK 仅 TS/Python；其他语言官方路径 = CLI 子进程（`-p --output-format json/stream-json`），已实测 |
| 与 Go AI 现状 | Go AI 只用其 **OpenAI 兼容模型 API**（`opencode.ai/zen/go/v1`），未用其 agent loop | GoFileAgentAdapter 走容器 HTTP（`go-ai-file-agent:18082`），可对照"容器化 executor"模式 |

---

## 1. OpenCode SDK

### 1.1 包信息

【结论】官方 SDK 为 `@opencode-ai/sdk`（不叫 `opencode-ai`；`opencode-ai` 包只是 CLI 安装器，7.9KB、无依赖、bin=opencode）。SDK 是 OpenAPI 自动生成客户端（含 `dist/v2/` 第二版 API），仅依赖 cross-spawn。**SDK 不是 loop 或 agent 本体——它是 opencode server 的 HTTP 客户端 + 进程管理器。**

【代码路径/命令】
```powershell
npm view opencode-ai            # 1.18.18, MIT, bin: opencode, dist 仅 7.9kB（CLI 安装器）
npm view @opencode-ai/sdk       # 1.18.18, MIT, deps: cross-spawn, 777kB
npm view @anthropic-ai/claude-agent-sdk  # 0.3.233, 4.5MB + 平台二进制（见 §3）
```

实装后文件清单（`node_modules/@opencode-ai/sdk/dist/`）：
```
index.d.ts / client.d.ts / server.d.ts        # 入口：createOpencode / createOpencodeClient / createOpencodeServer / createOpencodeTui
process.d.ts / error-interceptor.d.ts
gen/client.gen.*  gen/sdk.gen.*  gen/types.gen.*        # OpenAPI 生成客户端（v1）
gen/core/serverSentEvents.gen.*                          # SSE 客户端（含 Last-Event-ID 重连）
v2/…（client/server/gen）                                # v2 API 客户端（第二版协议）
```

【证据】
- `dist/index.d.ts`：`createOpencode(options?: ServerOptions): Promise<{ client: OpencodeClient; server: { url; close } }>`
- `dist/server.d.ts`：`ServerOptions = { hostname?, port?, signal?, timeout?, config? }`；`TuiOptions = { project?, model?, session?, agent?, ... }`
- `dist/server.js` L9-17：实现 = spawn `opencode serve --hostname=… --port=…`，配置经 **`OPENCODE_CONFIG_CONTENT` 环境变量**注入，解析 stdout 的 `opencode server listening on <url>` 判定就绪
- 冒烟测试实测（`smoke-opencode-sdk.mjs`，opencode CLI 1.18.16 本机已装）：`createOpencode()` 成功起 server（`http://127.0.0.1:43127`），`project.list` 返回 `["/", "D:\\Projects\\go-ai"]`，`session.create` 返回 `ses_ff87fe21affe2WhfM6rn19Vuic`，SSE `event.subscribe` 收到 `server.connected` / `server.heartbeat` 事件

【Go AI 对应/差距】
- 现有 `lib/opencode.ts` 是**纯模型 API 通道**（HTTP 直连 `https://opencode.ai/zen/go/v1/chat/completions` 等，OpenAI 兼容），与 SDK 无关——Go AI 从未驱动 opencode 的 agent loop，只消费其模型。
- SDK 的 `createOpencodeServer` 模式（进程内 spawn server）可直接对应到 Go AI 侧为 `opencode serve` 子进程 + HTTP 客户端；Go 无需 npm 包（协议是纯 HTTP）。

### 1.2 API 面：session 管理与任务执行

【结论】Session 管理是完整 REST 资源；**任务提交有两种**：`prompt`（POST 后阻塞至完成）与 `promptAsync`（204 立即返回，loop 在 server 内异步跑，事件走 SSE）。`promptAsync` 的 body 支持逐工具开关、agent 选择、system prompt 覆盖、模型覆盖——这正好是"executor 可编程驱动"的接口。

【代码路径/命令】
```bash
grep 'async (\w+)|(\w+)<' node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts
```

【证据】生成客户端端点（`dist/gen/sdk.gen.d.ts`，共 60+ 方法）：
- **session**（`client.session.*`）：`list create status delete get update children todo init fork abort unshare share diff summarize messages prompt message promptAsync command shell revert unrevert`
- **tool**：`ids list dispose`（`client.tool.*`）
- **mcp**：`status add connect disconnect` + oauth `auth/remove|start|callback|authenticate`
- **event**：`event`（全局 SSE）+ `subscribe`（`GET /event`，按 session 过滤）
- **config**：`get update providers`；**auth**：`set`（注入 provider key）；**pty**：`list create remove get update connect`
- `SessionPromptAsyncData`（`types.gen.d.ts` L2329）：`{ messageID?, model?: {providerID, modelID}, agent?, noReply?, system?, tools?: {[name]: boolean}, parts: Array<TextPartInput|FilePartInput|AgentPartInput|SubtaskPartInput> }`，返回 **204 void**（接受即返回）
- `EventSubscribeResponses`：`GET /event` → 200，SSE `Event` 判别联合

【Go AI 对应/差距】
- 语义与 `GoFileAgentAdapter.run()` 对齐：Go AI 发 prompt + maxTurns + model + 事件回调；opencode 侧对应 `promptAsync`（body 带 model/tools）+ SSE 订阅（事件回调）。**事件契约 `SandboxRunEvent`（tool/text/result/artifacts/done/error）需要一层归一化映射**（opencode 事件是 message/part 级细粒度，非 run 级）。

### 1.3 Server 模式协议

【结论】**HTTP 不是 JSON-RPC**：REST（effect HttpRouter/HttpApi）+ SSE（`/event`）+ WebSocket（pty/TUI 事件推送）+ OpenAPI 文档 `GET /doc`。server 默认监听 127.0.0.1，**无鉴权**（启动 WARN：`OPENCODE_SERVER_PASSWORD is not set; server is unsecured`）。状态持久化在 `~/.local/share/opencode/opencode.db`（SQLite）。

【代码路径/命令】
```bash
opencode serve --port 4096                 # 手动起 server（SDK 内部同命令）
curl http://127.0.0.1:4096/doc             # OpenAPI JSON（server 源码 public.ts → /doc 路由）
opencode serve --help                      # 参数：--hostname --port --log-level 等
```

【证据】`opencode-repo/packages/opencode/src/server/server.ts`：
- L101 `HttpRouter.serve(HttpApiApp.createRoutes(opts))` + `HttpApiApp.webHandler()`；L188-190 `GET /doc` 路由输出 `OpenApi.fromApi(PublicApi)` 缓存 JSON
- L11 `WebSocketTracker`：WebSocket 升级路由用于 pty/事件推送（`server.ts` 注释：`ptyConnectApiRoutes: typed WebSocket upgrade route with ticket-aware auth`）
- 会话状态跨进程共享：本机 `~/.local/share/opencode/opencode.db`（SQLite）+ `auth.json`（provider key）；冒烟测试两次运行间 `session.list` 能看到第一次建的 session
- 事件流实现 `gen/core/serverSentEvents.gen.js`：标准 SSE 解析，支持 `Last-Event-ID` 断线重连 + 指数退避（默认 3s→30s）

【Go AI 对应/差距】
- Go AI 的 opencode-go 通道目前只打 `chat/completions`；若 V1.5 让 Go AI 驱动 opencode server，可直接消费 `/doc` OpenAPI 生成 Go 客户端，**无需引入 npm**。
- 差距：server 无鉴权 → 需 `OPENCODE_SERVER_PASSWORD`（或仅绑定 127.0.0.1）；每 workspace 一个 server 进程还是全局共享需决策（全局共享则 session 隔离靠 sessionID，workspace 靠 `directory` query 参数）。

### 1.4 工具注册（plugin API）

【结论】自定义工具注册在插件 `Hooks.tool`：`{ [name]: ToolDefinition }`，ToolDefinition = `{ description, args: zod, execute(args, ctx) }`。另有 MCP 挂载（`mcp:server:*` 通配权限）、内置工具目录 `src/tool/`（read/write/edit/glob/grep/bash/webfetch/websearch/lsp/plan/task/todo/skill 等 20+）。运行时 `SessionTools.resolve()` 按 agent + session 组装工具集，插件与 MCP 工具都进同一个 LLM 工具表。

【代码路径/命令】
```
opencode-repo/packages/plugin/src/tool.ts            # ToolDefinition / ToolContext / tool() 定义
opencode-repo/packages/plugin/src/index.ts L226-228  # Hooks.tool: { [key: string]: ToolDefinition }
opencode-repo/packages/opencode/src/tool/registry.ts # ToolRegistry（内置工具注册）
opencode-repo/packages/opencode/src/session/tools.ts # SessionTools.resolve（agent 工具集组装）
```

【证据】`tool.ts`：
```ts
export type ToolContext = { sessionID; messageID; agent; directory; worktree; abort: AbortSignal;
  metadata(input); ask(input) }
export type ToolResult = string | { title?; output; metadata?; attachments? }
export function tool<Args extends z.ZodRawShape>(input: {
  description: string; args: Args;
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult> }) { return input }
```
插件钩子还有 `tool.execute.before/after`、`tool.definition`（改 LLM 看到的工具定义）、`chat.params`、`chat.headers`、`permission.ask`（`index.ts` L247-334）。

【Go AI 对应/差距】
- Go AI 目前工具能力在 file-agent 容器内（Claude Code 内置工具 + 容器编排），Go AI 侧没有工具注册面。若 opencode 成为 executor，**Go AI 可以把自有工具做成 opencode 插件**（一个 JS 文件 + config 挂载）或 MCP server 接入——接入成本低。

---

## 2. OpenCode Agent Loop（谁驱动循环）

### 2.1 循环位置

【结论】**loop 在 opencode 进程内，`session/prompt.ts` 的 `runLoop`（`while(true)`）驱动多轮**；每轮内工具执行由 **Vercel AI SDK 的 `streamText`** 完成（注释原文："AI SDK owns provider execution and tool dispatch"）。processor 只消费 LLM 事件流并维护 tool part 状态机。**SDK 客户端完全不用管循环**——`promptAsync` 一次调用即入队，server 自己跑完多轮。

【代码路径/命令】
```
packages/opencode/src/session/prompt.ts   # runLoop：多轮循环（L1081-1340）
packages/opencode/src/session/processor.ts # 单条 assistant 消息的事件状态机（665 行）
packages/opencode/src/session/llm.ts       # streamText 调用（L280），工具 execute 挂载
packages/opencode/src/session/llm/ai-sdk.ts# AI SDK 事件 → LLMEvent 归一化（tool-call/tool-result 等）
packages/opencode/src/session/llm/native-request.ts # 可选 native runtime（非 AI SDK 路径）
```

【证据】`prompt.ts` runLoop 每轮：
1. `status.set(busy)`；读消息（过滤已 compact 的）→ `MessageV2.latest` 取最后 user/assistant
2. **退出条件**（L1111-1130）：最后 assistant `finish` 非 `tool-calls` 且无未执行 tool part → break（日志 `exiting loop`）
3. 处理队列任务：`subtask`（子代理）与 `compaction`（溢出压缩），然后 `continue`
4. `SessionTools.resolve({agent, session, model, processor, ...})` 组装工具集（内置 + 插件 + MCP + json_schema 的 StructuredOutput）
5. 组装 system（env + instructions + mcp + skills）与 model messages → `handle.process({...tools, model, toolChoice})`
6. `processor.ts` 消费流：`tool-call` → 更新 part 为 running；`tool-result` → `completeToolCall` 写结果；`step-finish` → 记账（usage/cost）+ 快照 patch + 判断 overflow
7. 循环回 1：下一轮把 tool results 带回去（`MessageV2.toModelMessagesEffect`）

`llm.ts` L276-280 注释 + 调用：
```ts
// Default runtime path: AI SDK owns provider execution and tool dispatch;
// LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
result: streamText({ ...activeTools: Object.keys(prepared.tools), tools: prepared.tools,
  toolChoice: input.toolChoice, abortSignal: input.abort, messages: prepared.messages, ... })
```
工具 execute 的 ToolResult 形状（`toolResultOutput`，processor L257）：`{title, output, metadata?, attachments?}`——与插件 ToolResult 一致。

【Go AI 对应/差距】
- Go AI 现在"谁驱动循环"：file-agent 容器内 Claude Code 驱动（Go AI 只发 prompt + 收事件）。**若接入 opencode：循环驱动完全在 opencode server 内，Go AI 零循环逻辑**，与容器模式同构——接入语义最平滑。
- 差距：opencode 的 tool part 是 message/part 级细粒度事件，Go AI 需要按 `SandboxRunEvent` 归一化（tool 名 + detail；text 增量；终态 result/done/error）。

---

## 3. Claude Code 可调用接口

### 3.1 三个入口的定位

【结论】Claude Code 官方可编程入口三个：**(a) CLI `-p/--print` 非交互模式**（任何语言可用）；**(b) Agent SDK（`@anthropic-ai/claude-agent-sdk`，仅 TS/Python）**——进程内跑完整 agent loop 的库；**(c) MCP 工具服务器接口**（Claude Code 作为 MCP server 暴露能力给宿主）。SDK 底层就是 spawn CLI 子进程走 **stdio JSON-RPC**（`--input-format stream-json --output-format stream-json`）。**Go 不是 TS/Python → 官方正路是 (a) CLI 子进程**；SDK 若要接，需要 Node 中间层。

【代码路径/命令】
```powershell
claude -p "prompt" --output-format json              # 单发，结果 JSON（含 result/usage/session_id）
claude -p "prompt" --output-format stream-json --input-format stream-json --include-partial-messages  # 流式
claude -p "prompt" --output-format json --max-turns N --permission-mode acceptEdits --allowedTools "Bash Edit Read"
claude -p "prompt" --output-format json --session-id <id>   # resume 指定会话
claude --print --json-schema '{"type":"object",...}'        # 结构化输出
```
实测（本机 claude 2.1.233 + ANTHROPIC_BASE_URL 中转）：
```json
{"is_error":false,"duration_api_ms":11732,"num_turns":1,"stop_reason":"end_turn",
 "session_id":"25d36b99-...","total_cost_usd":0.0951,"result":"PONG_CLI_OK","subtype":"success", ...}
```

【证据】
- `claude --help`：`-p, --print`（非交互）；`--output-format <text|json|stream-json>`；`--input-format <text|stream-json>`；`--include-partial-messages`；`--max-turns`；`--permission-mode`；`--json-schema`；`--mcp-config`；`--allowedTools`
- SDK `sdk.mjs` 中 spawn CLI 的参数：`--input-format stream-json --output-format stream-json`（grep 实证），外加 `--max-turns/--permission-mode/--model/--mcp-config/--include-partial-messages/--include-hook-events/--session-mirror` 等
- SDK manifest：`node_modules/@anthropic-ai/claude-agent-sdk/manifest.json` —— `version: 2.1.233`（与本地 CLI 完全同版本），内嵌二进制 `win32-x64/claude.exe` 320MB，8 平台；`sdkCompat.testedWrapperVersions` 0.3.195→0.3.227
- 官方文档（code.claude.com/docs/en/agent-sdk/overview）："To drive the same agent loop from another language, run the CLI as a subprocess with the `-p` flag and `--output-format json`"

【Go AI 对应/差距】
- **GoFileAgentAdapter（`lib/sandbox/dockerClaudeCode.ts`）已是"CLI-as-executor"的容器化版本**：`id=claude-code-file-agent`，HTTP 到 `go-ai-file-agent:18082`（`/health`、`/task`、HEAD 探测），payload 带 `model/maxTurns/gatewayBaseUrl/gatewayToken/visionMd/memory/style/skills`。
- 差距：容器内跑的是 Claude Code 完整 harness（多轮 + 工具 + 记忆），**外部只看得到归一化事件**；若需 SDK 级控制（自定义工具、hook、permission 决策、会话 fork），现在做不到——要么升级容器内 harness（file-agent 里用 SDK 或 stream-json 模式），要么加 Node 中间层。
- 直接 CLI 子进程模式（不经容器）也可行：`spawn claude -p --output-format stream-json`，Go 侧解析 JSONL。成本最低，但丢失容器隔离。

### 3.2 Agent SDK 能力面（TS）

【结论】SDK = 一个 `query()` 入口（返回 `Query extends AsyncGenerator<SDKMessage>`）+ 60+ 项 `Options`。**任务执行、上下文管理、重试、工具执行全在 SDK 内**，宿主只消费事件流。还提供会话管理 API（`listSessions/getSessionInfo/getSessionMessages/forkSession/deleteSession/renameSession/tagSession`）+ 自定义工具（`tool()` zod 定义）+ `createSdkMcpServer`（SDK 作为 MCP server 被其他宿主挂载）。

【代码路径/命令】
```powershell
node -e "const m=require('./node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'); console.log(Object.keys(m).join('\n'))"
# AbortError, DirectConnectError, InMemorySessionStore, createSdkMcpServer, deleteSession, forkSession,
# getSessionInfo, getSessionMessages, getSubagentMessages, listSessions, listSubagents, query,
# renameSession, resolveSettings, startup, tagSession, tool, ...
```

【证据】`sdk.d.ts` 关键类型：
- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options?: Options }): Query`
- `Query extends AsyncGenerator<SDKMessage, void>`，控制方法：`interrupt()`、`setPermissionMode(mode)`、`setModel(model?)`、`setMaxThinkingTokens(n)`（流式输入模式才可用）
- `Options` 字段（60+，实测列全）：`abortController additionalDirectories agent agents allowedTools canUseTool continue cwd disallowedTools toolAliases tools env executable executableArgs extraArgs fallbackModel enableFileCheckpointing toolConfig forkSession betas hooks onElicitation onUserDialog persistSession sessionStore loadTimeoutMs includeHookEvents includePartialMessages forwardSubagentText thinking effort maxThinkingTokens maxTurns maxBudgetUsd mcpServers model outputFormat pathToClaudeCodeExecutable permissionMode planModeInstructions allowDangerouslySkipPermissions permissionPromptToolName plugins promptSuggestions resume sessionId resumeSessionAt sandbox settings settingSources skills debug debugFile stderr strictMcpConfig systemPrompt append excludeDynamicSections title spawnClaudeCodeProcess`
- `env?: { [envVar: string]: string | undefined }` —— 任意环境变量透传给 CLI 子进程（含 ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / ANTHROPIC_MODEL）
- 自定义工具：`tool(name, description, inputSchema, handler)`（顶层导出，zod schema）
- `toolAliases`：把内置工具重定向到宿主工具（如 `{ Bash: 'mcp__workspace__bash' }`）——远程沙箱模式官方支持点
- Hook 事件常量 `HOOK_EVENTS`：30+（PreToolUse/PostToolUse/PostToolUseFailure/PostToolBatch/Notification/UserPromptSubmit/UserPromptExpansion/SessionStart/SessionEnd/Stop/SubagentStart/SubagentStop/PreCompact/PostCompact/PermissionRequest/PermissionDenied/Setup/TeammateIdle/TaskCreated/TaskCompleted/Elicitation/ConfigChange/WorktreeCreate/FileChanged/MessageDisplay 等），宿主可以 `hooks` 选项注册回调

【Go AI 对应/差距】
- `query()` 的 options 面（cwd/model/maxTurns/permissionMode/mcpServers/systemPrompt）与 Go AI `SandboxRunRequest`（job/prompt/maxTurns/model/memory/style/skills/visionMd）高度同构——**若 file-agent 容器内升级为 SDK 驱动，SandboxRunRequest → Options 映射是直译级**。
- 差距：SDK 是 TS 库；Go AI 是 Node/TS 服务端（`lib/` 下 TS），**可以直接引入 SDK 而不用中间层**（这是相比纯 Go 路线的关键优势：Go AI 的适配层本来就是 TS）。

### 3.3 认证与端点覆盖

【结论】**需要 ANTHROPIC_API_KEY**（SDK 从宿主进程 env 读，不自动读 .env；`options.env` 也可显式传）。**ANTHROPIC_BASE_URL 官方支持指向自定义代理/网关**（第一方 host 之外时 MCP tool search 默认关闭、Remote Control 禁用，属已知边界）。第三方 provider 认证：Bedrock/Vertex/Foundry 各用 `CLAUDE_CODE_USE_*` 环境变量。**本机实测**：SDK 冒烟测试与 CLI `-p` 均走 `ANTHROPIC_BASE_URL=http://127.0.0.1:15721` 中转成功。

【代码路径/命令】
```powershell
$env:ANTHROPIC_API_KEY="sk-..."        # SDK/CLI 读进程 env
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:15721"   # 自定义端点（本机验证）
$env:ANTHROPIC_MODEL="claude-opus-4-8[1m]"          # 覆盖模型
claude -p "hi"                          # 冒烟
```

【证据】
- 官方 Quickstart（code.claude.com/docs/en/agent-sdk/quickstart）："The SDK reads the key from the environment of the process that runs your agent; it doesn't load `.env` files automatically."
- 官方 env-vars 页：`ANTHROPIC_API_KEY`（覆盖订阅登录）；`ANTHROPIC_BASE_URL`（"overrides the API endpoint to route requests through a proxy or gateway"）；`ANTHROPIC_AUTH_TOKEN`（自定义 Authorization，自动加 Bearer）；`ANTHROPIC_MODEL`；`ANTHROPIC_CUSTOM_HEADERS`（v2.1.227+）
- 冒烟测试结果（`smoke-claude-sdk.mjs`）：事件序列 `system:14 assistant:2 result:1`，assistant text = `PONG_OK`，result `subtype=success`，总耗时 ~11s，费用记账正常——**链路证明 env 透传 + 中转端点 + 事件流全通**
- 官方明文限制："Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products"——API key 认证是合规唯一路径（对 Go AI 无影响，Go AI 本就计划用 key）

【Go AI 对应/差距】
- Go AI 现有 `lib/llm/complete.ts` 已有 opencode-go 与 anthropic 双通道；anthropic 通道走官方 API key。若 V1.5 以 Claude Code 为 executor，凭据策略不变（key 放服务端 env，经 ANTHROPIC_BASE_URL 可指向企业网关）。
- 差距/注意：非第一方 host 时 MCP tool search 默认禁用（`ENABLE_TOOL_SEARCH=true` 可开）、Remote Control 禁用——中转场景需按需显式开启。

### 3.4 MCP 工具服务器接口

【结论】Claude Code 可被驱动为 **MCP server**（SDK 的 `createSdkMcpServer()` 把 SDK 会话包成 MCP server；Claude Code 也支持被 MCP 客户端连接），也可消费 MCP（`mcpServers` 选项）。对 Go AI 的意义：如果 Go AI 的宿主（比如未来的桌面端）是 MCP 客户端，Claude Code executor 可直接以 MCP 形式接入，协议级互操作。

【代码路径/命令】
```ts
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
const server = createSdkMcpServer({ name: "go-ai-executor", options: { cwd, permissionMode } })
```

【证据】`sdk.d.ts`：`createSdkMcpServer(_options: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance`；`McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfigWithInstance`。

【Go AI 对应/差距】Go AI 无 MCP 客户端基础设施（目前是 HTTP + 业务事件）。此项为**可选加分项**，不作为接入前提。

---

## 4. 事件 / 进度流对比

【结论】两边都支持**流式事件**，粒度都到 tool 级，且都覆盖 text/tool/结果/错误/进度：

| 能力 | OpenCode（SSE /event） | Claude Agent SDK（AsyncGenerator<SDKMessage>） |
|---|---|---|
| 文本增量 | `EventMessagePartUpdated`（type=text, delta 字段） | `assistant`（含 content blocks）+ `includePartialMessages` 开 partial 增量 |
| 工具调用 | `EventMessagePartUpdated`（type=tool, state: pending→running→completed/error, input/output/metadata） | `assistant` 消息 content 里 `tool_use` block（name+input）；`result` 前有 tool 结果消息 |
| 完成 | `EventSessionIdle`（status=idle）+ 轮询 `session.status`；`EventMessageUpdated`（finish reason） | `result` 消息（subtype: success/error_max_turns/error_during_execution…，含 cost/usage/numTurns） |
| 错误 | `EventSessionError`（error 对象） | `result.isApiErrorMessage`；`api_error`/`system` 消息 |
| 权限 | `EventPermissionUpdated` / `EventPermissionReplied` | `system` 消息含 permission 请求；`canUseTool` 回调决策 |
| 其他 | `EventTodoUpdated`（todo 工具）、`EventCommandExecuted`、`EventFileEdited`、`EventVcsBranchUpdated`、`server.heartbeat` | hook 事件（30+ 类型，`includeHookEvents`）、`SDKToolProgressMessage`、task/background task 进度、token 用量（`SDKThinkingTokensMessage` 等） |

【证据】
- OpenCode：`types.gen.d.ts` Event 联合 40+ 类型（§1.2 已列）；SSE 实测收到 `server.connected`/`server.heartbeat`
- Claude SDK：`SDKMessage` 判别联合 40+ 类型（`sdk.d.ts`），实测事件序列 `system:14 → assistant:2 → result:1`
- OpenCode promptAsync 是**异步**（204 立即返回），宿主必须订阅事件或轮询 status 才能感知完成；Claude SDK `query()` 是**同步迭代**（for-await 直到 result）——两种宿主模型不同，Go AI 适配器要注意

【Go AI 对应/差距】
- Go AI `SandboxRunEvent`（tool/text/result/artifacts/done/error）在两边都**可映射**，但映射表不同：opencode 需从 part 级事件聚合出"run 级"事件；Claude SDK 需从 assistant/result 消息聚合。
- 事件体积：opencode SSE 每 token 增量都发事件（text delta / tool input delta），比 Claude SDK 默认（整条 assistant 消息）更细——带宽与解析成本更高。

---

## 5. 结论：V1.5 "可插拔 specialized executor" 可行性

### 5.1 两条路径的可行性与接入成本

**路径 A：OpenCode server 作为 executor（推荐优先评估）**
- 可行性：**高**。协议是纯 HTTP（REST + SSE + OpenAPI `/doc`），Go 侧零依赖可驱动；agent loop 完全在 server 内（`promptAsync` 一次提交跑完多轮）；session/tool/mcp/权限全有 API；模型通道已就绪（Go AI 已配置 zen/go provider + auth.json）。
- 接入成本：**低**。≈ 新增一个 `AgentRuntimeAdapter` 实现（对标 `GoFileAgentAdapter`）：spawn/连接 `opencode serve` + `session.create` + `promptAsync` + SSE 订阅 → 归一化为 `SandboxRunEvent`。事件映射是主要工作量（part 级 → run 级）。
- 风险/边界：server 默认无鉴权（设 OPENCODE_SERVER_PASSWORD）；全局 SQLite 状态（多实例需决定共享/隔离策略）；模型端点可用性（实测 zen/go 曾 503，需健康检查与降级，Go AI `providerHealth.ts` 已有探测）。

**路径 B：Claude Code 作为 executor（保持现有容器化，或加 CLI/SDK 直连）**
- 可行性：**高**（现状已在跑），但可编程控制面分两档：
  - 现状档（容器 HTTP）：`GoFileAgentAdapter` 已交付线上，保持不动成本为零；控制面 = 容器内 harness 决定（prompt + maxTurns + model）。
  - 增强档：**Go AI 适配层是 TS，可直接内嵌 `@anthropic-ai/claude-agent-sdk`**（`query()` + Options），获得自定义工具（zod）、canUseTool 权限决策、30+ hook 事件、会话 fork/resume、结构化输出——这是比"CLI 子进程"更强且仍受官方支持的路径（file-agent 容器内嵌 SDK，或宿主进程直连 SDK 起新会话）。
  - Go 原生路径（不经 TS）：CLI 子进程 `-p --output-format stream-json`，已实测；能力 = SDK 的 80%（无 hook 注册、无自定义工具 schema、无 in-process 控制方法）。
- 接入成本：现状档 0；增强档 = 把 file-agent 容器的执行内核换成 SDK 调用（SandboxRunRequest → Options 直译级映射）+ 事件归一化（assistant/result → SandboxRunEvent）。
- 风险/边界：认证必须 ANTHROPIC_API_KEY（合规路径，无 claude.ai 登录代理）；ANTHROPIC_BASE_URL 可指向自建网关（实测 OK，注意非第一方 host 的 MCP tool search/Remote Control 限制）；内嵌 SDK 会拉起完整 harness 进程（内存/启动成本）。

### 5.2 与现有代码的对应关系

| 现有 Go AI 组件 | 对应物 |
|---|---|
| `lib/opencode.ts`（zen/go OpenAI 兼容模型通道） | OpenCode provider 配置的**同源通道**（`opencode.ai/zen/go/v1`）；V1.5 语义不变——模型池与 executor 解耦 |
| `lib/sandbox/adapter.ts` `AgentRuntimeAdapter` + `SandboxRunEvent` | 统一"executor 抽象"——OpenCode/Claude Code 都实现它；**V1.5 无需改接口，新增实现即可** |
| `lib/sandbox/dockerClaudeCode.ts` `GoFileAgentAdapter`（HTTP → file-agent 容器） | Claude Code executor 现状实现；增强档可内部换 SDK 内核，对外契约不变 |
| `lib/sandbox/agentscopeRuntime.ts`（AgentScope 2.0 runtime） | 第三条 executor 实现，验证了"多 executor 并存"模式 |
| file-agent 容器（Claude Code + DeepSeek V4 Flash） | 容器化 executor 载体；opencode 路径无需新容器（server 即进程） |
| `lib/policy/providerHealth.ts`（provider 探测） | 可复用于 executor 健康检查（opencode serve /health、SDK prepare()） |

### 5.3 决策建议（供 V1.5 设计会）

1. **接口层不动**：`AgentRuntimeAdapter` 已是正确的 executor 抽象；新增 `OpenCodeServerAdapter`（id=`opencode-server`）与增强版 `ClaudeCodeRuntimeAdapter`（id 不变）。
2. **OpenCode 优先试点**：HTTP 开放、Go 可直驱、与现有模型通道同源（zen/go），试点成本最低。试点内容：进程管理（serve + OPENCODE_SERVER_PASSWORD + /doc 生成客户端）、事件归一化映射表、多 workspace 隔离策略。
3. **Claude Code 增强走 SDK 内嵌**（适配层是 TS 的天然红利），不要把"Go 原生驱动 CLI"作为主线（丢 hook/自定义工具/权限决策）。
4. **保留双通道降级**：模型端点（zen/go）与 executor 都做健康检查 + 降级（复用 providerHealth 模式）。

---

## 附录 A：可复现命令集

```powershell
# 包信息
npm view opencode-ai ; npm view @opencode-ai/sdk ; npm view @anthropic-ai/claude-agent-sdk

# 实装（本次研究用）
mkdir D:\Projects\go-ai\docs\tmp-sdk-audit ; cd D:\Projects\go-ai\docs\tmp-sdk-audit
npm init -y ; npm install @opencode-ai/sdk@1.18.18 @anthropic-ai/claude-agent-sdk@0.3.233

# Claude SDK 冒烟（需 ANTHROPIC_API_KEY；本机可走 ANTHROPIC_BASE_URL 中转）
node D:\Projects\go-ai\docs\tmp-sdk-audit\smoke-claude-sdk.mjs
# 期望：system:14 assistant:2 result:1 + "PONG_OK"

# OpenCode SDK 冒烟（需本机 opencode CLI；prompt 结果依赖 zen/go 端点可用性）
node D:\Projects\go-ai\docs\tmp-sdk-audit\smoke-opencode-sdk.mjs

# CLI headless（Go 侧正路）
claude -p "Reply with exactly: PONG_CLI_OK" --output-format json --max-turns 1

# opencode server 手动验证
opencode serve --port 4096
curl http://127.0.0.1:4096/doc | head      # OpenAPI 文档

# 源码研究（已克隆）
cd D:\Projects\go-ai\docs\tmp-sdk-audit\opencode-repo   # git clone --depth 1 https://github.com/anomalyco/opencode.git
```

## 附录 B：临时研究目录处置

`D:\Projects\go-ai\docs\tmp-sdk-audit\`（npm 实装 + 冒烟脚本 + opencode-repo 浅克隆）为研究产物，确认后删除：
```powershell
Remove-Item -Recurse -Force D:\Projects\go-ai\docs\tmp-sdk-audit
```
注意：`~/.local/share/opencode/` 下的 opencode.db / auth.json 为冒烟测试产生的本机状态（auth.json 是既有的 Go AI 配置，勿删）。
