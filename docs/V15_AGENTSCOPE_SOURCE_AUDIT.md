# AgentScope 2.0.6 源码审计：能否承担 Go AI 主 Agent Harness

> 审计对象：`agentscope 2.0.6`（Apache-2.0，Alibaba Tongyi Lab）
> 安装位置：`C:\Users\SXY\AppData\Local\Python\pythoncore-3.14-64\Lib\site-packages\agentscope\`
> 审计方法：直接阅读源码（非 README/docstring 转述），逐文件核对实现。
> 版本事实：`pip show agentscope` 确认 2.0.6；依赖含 `mcp`、`openai`、`anthropic`、`docstring_parser`、`python-socketio`、`tree_sitter` 等。
>
> 下文所有行号均以安装目录内实际文件为准（相对路径省略包前缀 `agentscope/`）。

---

## 1. Agent loop 谁负责

### 【结论】

AgentScope 2.0 的 `Agent` 类自带完整的 reasoning-acting（ReAct）主循环，位于 `Agent._reply_impl`。**loop 的所有权在 AgentScope 侧，不在业务侧**——业务方只需调用 `agent.reply_stream()`（异步生成器，逐事件产出），循环、工具回填、迭代上限全部内建。另有 `observe()` 用于多轮外部观察注入，但没有独立的 plan-act 二阶段 loop（plan 以"任务工具 + 运行时注入"的形式存在，见下）。

### 【代码路径】

- `agent/_agent.py:759` `_reply_impl`（核心循环主体）
- `agent/_agent.py:863` `while True` 循环入口；`_next_action()` 三态决策
- `agent/_agent.py:3050` `_next_action`（Reasoning / Acting / Exit 状态机）
- `agent/_agent.py:1257/1314` `_reasoning` / `_reasoning_impl`（调模型、流式转换）
- `agent/_agent.py:2336/2390` `_acting` / `_acting_impl`（执行工具）
- `agent/_agent.py:2809/2839` `_prepare_model_input` / `_call_model`
- `agent/_config.py:282` `ReActConfig`（`max_iters` 默认 20，`agent/_config.py:285`）
- `agent/_agent.py:344` `observe()`

### 【证据】

`_reply_impl` 的主循环（`_agent.py:863-978`）：

```python
while True:
    next_action = self._next_action(final_msg)     # :867
    match next_action:
        case Exit(...):      # :870 结束回复
        case Reasoning(...): # :877 压缩上下文→注入运行时状态→_reasoning
        case Acting(...):    # :918 分批执行工具（sequential/concurrent）
```

- **tool call → 结果回填模型的循环**：`_reasoning_impl` 把模型输出转成 `ToolCallBlock` 存入 `state.context`（`_agent.py:1344` `_prepare_model_input` 拼装消息+tools）；`_execute_tool_call`（`:2048`）执行后 `_save_to_context` 追加 `ToolResultBlock`（`:2988`）；下一轮 `while` 迭代时 `_prepare_model_input` 把含工具结果的完整 context 再发给模型。即"模型调用→工具执行→结果入上下文→再调模型"闭环由 `_reply_impl` 单一职责驱动。
- **迭代上限**：`_next_action` 在 `state.cur_iter >= react_config.max_iters` 时产出 `ExceedMaxItersEvent` + `ReplyEndEvent(EXCEED_MAX_ITERS)`（`_agent.py:3167-3165` 区间，见 `:3167`、`:3215`）。
- **plan 的对应物**：没有 plan-act 两段式，但有任务系统——`state/_task.py:11` `Task`（pending/in_progress/completed），`tool/_task/` 下 `_create_task.py`/`_list_task.py`/`_update_task.py` 是规划工具；`_inject_runtime_state`（`_agent.py:1014`）把时间/任务/上下文占用注入为 `HintBlock` 进上下文。go-ai 的"plan 阶段"需要映射到任务工具或自行在 system prompt 里做。
- **多轮**：`observe()` 把外部消息写进 context，下一次 `reply(None)` 继续。

### 【Go AI 对应/差距】

- Go AI `lib/agent/loop.ts:10` 的 `AgentLoopPhase`（plan/act/observe/validate/repair/finish）是**纯 UI 状态机**（`advanceLoop`，`loop.ts:35`），本身不驱动执行；执行由 runtime（Claude Code / AgentScope）驱动。若 AgentScope 作主 harness，真正的 loop 由 AgentScope 承担，Go AI 的 `advanceLoop` 可保留为 UI 阶段机。
- **差距**：AgentScope 无 validate/repair 语义（执行器 `lib/tasks/executor.ts`/`devExecutor.ts` 的验收-修复循环需保留在 Go AI 侧，通过观察工具结果事件触发）。

---

## 2. Tool 系统

### 【结论】

工具系统完备，两套注册方式（Python 函数装饰式封装 + MCP 工具适配），schema 由**函数签名 + docstring 解析**自动生成（也可用 Pydantic 模型），支持流式输出、并发安全标注、工具组激活/停用、动态增删。**关键机制：`is_external_tool=True` 的外部工具协议**——agent 执行到此类工具时暂停并产出 `RequireExternalExecutionEvent`，等待外部系统回投 `ExternalExecutionResultEvent` 恢复。这正是 Go AI JS 侧工具（spreadsheet/artifact.register）接入的原生协议。

### 【代码路径】

- `tool/_toolkit.py:66` `Toolkit`（注册中心：工具/MCP/技能，分组管理）
- `tool/_toolkit.py:225` `call_tool`（工具调用统一入口，流式 ToolChunk → ToolResponse）
- `tool/_toolkit.py:628/670` `add_tool` / `remove_tool`（动态注册）
- `tool/_adapters.py:31` `FunctionTool`（Python 函数 → 工具）
- `tool/_adapters.py:167` `MCPTool`（MCP 工具适配）
- `tool/_utils.py:46` `_extract_func_description`（docstring → 描述）
- `tool/_utils.py:68` `_extract_input_schema`（签名+docstring → JSON Schema）
- `tool/_base.py:94` `ToolBase` 协议（name/description/input_schema/is_concurrency_safe/is_read_only/is_external_tool/is_state_injected/is_mcp）
- `tool/_base.py:36` `ToolMiddlewareBase`（工具级洋葱中间件）
- `tool/_builtin/`：Bash/Read/Write/Edit/Glob/Grep/Powershell/Skill/Backend 等内建工具
- `mcp/`：`MCPClient`（stdio/streamable http/sse 客户端）

### 【证据】

- **注册**：无装饰器（对比 @tool 风格），而是 `Toolkit(tools=[...], mcps=[...], skills=[...])` 构造 + `add_tool` 动态添加；工具按 `ToolGroup` 分组（`tool/_toolkit.py:127`），组可被 agent 通过内置 `ResetTools` 元工具自行激活/停用（`tool/_toolkit.py:156`）。
- **schema 生成**：`FunctionTool.__init__`（`_adapters.py:78-82`）→ `_extract_input_schema`（`_utils.py:68`）用 `docstring_parser.parse` 取参数描述 + `inspect.signature` 取类型/默认值 + Pydantic `create_model` 动态建模型出 JSON Schema（`_utils.py:91-139`）；描述取 docstring short+long description（`_utils.py:46-65`）。
- **执行与返回**：`Toolkit.call_tool`（`:225`）统一入口——解析入参（`_json_loads_with_repair`）、按激活组查可用性、状态注入（`is_state_injected` 注入 `_agent_state`，`:302-307`）、调用后归一为 `ToolChunk` 流 + 收尾 `ToolResponse`（`:386-388`）；异常（含 `asyncio.CancelledError`）转为 `ToolResultState.ERROR/INTERRUPTED` 的 chunk（`:352-384`）。
- **外部工具协议**：`ToolBase.is_external_tool=True`（`_base.py:108`）；agent 侧 `_execute_tool_call` 对外部工具产出 `RequireExternalExecutionEvent` 并暂停（`_agent.py:2048` 之后的 permission 分支；事件定义 `event/_event.py:421`）；恢复入口 `ExternalExecutionResultEvent`（`event/_event.py:486`），`_handle_incoming_event` 把结果写回上下文并置 `ToolCallState.FINISHED`（`_agent.py:1625-1647`）。**注意**：`ToolOffloadMiddleware` 明确跳过 `is_external_tool`（`app/middleware/_tool_offload_middleware.py:157-162`），外部工具必须走事件回投，不会转后台。
- **MCP**：`MCPClient` 支持 stdio / streamable HTTP（`mcp` 官方包）；MCP 工具经 `MCPTool` 包装进入 toolkit（`tool/_adapters.py:167-`），命名 `mcp_name.tool_name`，由 `client.list_tools()` 拉取（`tool/_toolkit.py:519-533`）。

### 【Go AI 对应/差距】

- Go AI `lib/tools/registry.ts:33` `AgentTool`（name/description/inputSchema/permission/capabilities/…）与 `ToolBase` 字段高度同构，但 **schema 是手写的**（`registry.ts:58-157` filesystem/archive 工具），AgentScope 是签名+docstring 自动生成——差距可消除。
- **JS 侧工具接入**：两条路。
  1. **外部工具协议（推荐）**：Go AI 在 AgentScope 进程里注册 `FunctionTool`（薄包装，`is_external_tool=True`），agent 调用时暂停产出 `REQUIRE_EXTERNAL_EXECUTION` 事件；Go AI JS 侧执行 spreadsheet/artifact.register 等真实逻辑后 POST `ExternalExecutionResultEvent`（`app/_router/_chat.py:49` 的 `/chat/` 已接受该事件类型做 resume，`app/_service/_chat.py:229-249` 注释明确支持）。这是 AgentScope 为跨进程工具设计的原生通道。
  2. HTTP 回调包装：Python 侧写一个 `ToolBase` 实现，`call()` 里向 Go AI 内部 API 发请求取结果（同步阻塞路径）。
- **差距**：Go AI 的 `capabilities`/`runtimeAvailability`/`timeoutMs`/`sideEffects` 元数据（`registry.ts` TOOL_META）无 AgentScope 对应字段，需保留在 Go AI 策略层（授权工具集合 `authorizedTools` 逻辑不变）。

---

## 3. Workspace/Sandbox

### 【结论】

有完整的分层 sandbox 体系：`WorkspaceBase`（布局+offload+技能/MCP 持久化）→ `SandboxedWorkspaceBase`（沙箱语义、网关）→ 具体后端（Local/Docker/E2B/OpenSandbox/k8s/bubblewrap/applecontainer/daytona）。文件操作与命令执行统一抽象为 `BackendBase`（exec_shell/read_file/write_file/list_dir/stat/…），Local 走本地进程、Docker 走容器内执行。DockerWorkspace 用 aiodocker 管理容器生命周期（内容哈希镜像、可选 host bind-mount 持久化、容器内 MCP 网关）。**没有与外部 dind 服务的专用集成**，但 DockerBackend 经 aiodocker 驱动，指向远程 docker daemon（DOCKER_HOST 语义）即等价于外部沙箱。

### 【代码路径】

- `workspace/_base.py:145` `WorkspaceBase`；布局 `${workdir}/{.mcp,data/,skills/,sessions/}`（docstring `:31-42`，属性 `:247-270`）
- `workspace/_base.py:455/511` `offload_context` / `offload_tool_result`（压缩上下文与工具结果卸载，可检索）
- `workspace/_sandboxed_base.py:38` `SandboxedWorkspaceBase`（沙箱文件操作经容器内 python shim 执行；tar 解包防穿越 shim 见 `workspace/_base.py:83-139`）
- `tool/_builtin/_backend.py:138` `BackendBase`：`exec_shell`(:285)、`read_file`(:322)、`write_file`(:335)、`write_stream/read_stream`、`getcwd`(:397)、`list_dir`(:483)、`scandir`(:533)、`stat`(:569)、`delete_path`(:693)
- `tool/_builtin/_backend.py:732` `LocalBackend`（本地进程执行）
- `workspace/_docker/_docker_backend.py:68` `DockerBackend.exec_shell`（容器内执行）
- `workspace/_docker/_docker_workspace.py:43` `DockerWorkspace`；`__init__`(:52，base_image/host_workdir/node_version/extra_pip/env)；`is_persistent`(:135，仅 host_workdir 时持久)；`_build_or_reuse_image`(:202，内容哈希镜像)
- `app/workspace_manager/_local_workspace_manager.py:15`（basedir + `IsolationPolicy.PER_AGENT`（:28-36）+ TTL 缓存 :58）
- `app/workspace_manager/_docker_workspace_manager.py:47`（TTL 缓存 + 后台 sweep :353）
- `app/workspace_manager/_opensandbox_workspace_manager.py:49`、`workspace/_opensandbox/_opensandbox_workspace.py:36`（远程沙箱：创建/挂接/重建）
- `workspace/_gateway_client.py:352` `GatewayClient`（Docker 容器内 MCP 网关的宿主侧客户端）

### 【证据】

- **隔离**：LocalWorkspaceManager 默认 `IsolationPolicy.PER_AGENT`（`:28`），每个 agent 一个 workdir；Docker 每容器一 workspace；OpenSandbox/E2B 为远程沙箱（OpenSandbox 支持按 sandbox 元数据重挂接，`_opensandbox_workspace.py:216-299`）。
- **卷**：Docker 通过 `host_workdir` bind-mount 到容器 `/workspace`（`_docker_workspace.py:79-81`、`:116-118`），持久化 `.mcp/skills/sessions/data`。
- **跑命令/代码**：`BackendBase.exec_shell` 抽象；`Bash`/`Powershell` 内建工具（`tool/_builtin/_bash.py`、`_powershell.py`）经 `workspace.get_backend()` 执行；文件工具（Read/Write/Edit/Glob/Grep）同样走 backend，因此天然容器内运行。
- **外部沙箱集成**：无 dind 专用代码路径；`aiodocker` 驱动（`_docker_workspace.py:129`）可用 DOCKER_HOST 指向远端 daemon；OpenSandboxWorkspaceManager 是官方的外置沙箱通道（复用 `SandboxedWorkspaceBase` 语义）。

### 【Go AI 对应/差距】

- Go AI `lib/sandbox/manager.ts:81` `SandboxManager` + `SandboxProvider`（:58）的 allocate/prepare/exec/readFile/writeFile/listFiles/snapshot/restore/terminate/cleanup —— AgentScope 对应物：`WorkspaceManagerBase.get_workspace/create_workspace/close` + `BackendBase` 文件/命令 API。**接口一一对应但命名不同**。
- **差距 1（必须保留）**：`snapshot/restore`（workspace 版本化，`manager.ts:71-73`）在 AgentScope 2.0.6 无对应物（offload 是检索不是版本）。
- **差距 2（必须保留）**：资源限额 `SandboxLimits`（memoryMb/cpuShares/pidsLimit，`manager.ts:16-24`）在 DockerWorkspace/DockerWorkspaceManager 公开 API 中未暴露。
- **差距 3（必须保留）**：Go AI 的 per-task 沙箱 + 任务 workspace 同步逻辑（`lib/sandbox/agentscopeRuntime.ts` 的 syncToAgentWorkspace/syncBackOutputs）是业务层约定，AgentScope 不感知 task/input/working/output 布局，需保留。
- 好消息：Go AI 现有 `AgentScopeRuntimeAdapter`（`lib/sandbox/agentscopeRuntime.ts`）已按 `WORKSPACES_ROOT` 约定工作，若 AgentScope 自身托管 workspace（LocalWorkspaceManager）则该同步层可整体删除。

---

## 4. Event/Message bus

### 【结论】

事件体系完备：agent 层产出 26 种结构化 `AgentEvent`（pydantic 模型，`EventType` 枚举）；服务层经 `MessageBus`（Redis pub/sub + list 队列 + 日志 + 分布式锁 + registry）发布；客户端通过 **SSE**（`GET /sessions/{session_id}/stream`）实时订阅（**非 WebSocket**，依赖 Redis pub/sub 订阅在线通道 + Redis list 持久回放）。事件包含对话流（TEXT_BLOCK_*）、工具事件（TOOL_CALL_*/TOOL_RESULT_*）、状态（REPLY_START/END）、HITL（REQUIRE_USER_CONFIRM / REQUIRE_EXTERNAL_EXECUTION）等全部所需类型。

### 【代码路径】

- `app/message_bus/_base.py:53` `MessageBus` 抽象：`publish`(:263)/`subscribe`(:283)/`queue_push`(:96)/`log_append`(:175)/`acquire_lock`(:326)/`registry_*`(:402-494)
- `app/message_bus/_base.py:536/562/580/597/614` `session_run`（会话级分布式锁）/`session_publish_event`/`session_read_events`/`session_subscribe_events`/`session_publish_cancel`
- `app/message_bus/_redis_message_bus.py:19` `RedisMessageBus`（`publish` :491，`subscribe` :510 pubsub 循环；含"订阅就绪"信号防丢事件）
- `app/message_bus/_keys.py` `MessageBusKeys`（业务键约定：session_lock/session_cancel_channel/session_interrupt_channel/队列 wakeup 类型等）
- `app/_bus_ops.py:40` `publish_session_event`（事件同时写回放日志 + 发布在线通道）
- `event/_event.py:26` `EventType`（26 个类型）；`event/_event.py:533` `AgentEvent` 联合类型
- `app/_router/_session.py:764` `GET /sessions/{session_id}/stream`（SSE StreamingResponse）

### 【证据】

- **传输**：SSE 端点 `stream_session_events`（`_session.py:764` 起）从 `message_bus.session_subscribe_events` 订阅并转 `StreamingResponse`；事件即 `AgentEvent.model_dump(mode="json")` 的 JSON。go-ai 的 `lib/agentscope/client.ts:57` 已用 `Accept: text/event-stream` 订阅该端点。
- **事件类型**（`event/_event.py:29-67`）：REPLY_START/END、MODEL_CALL_START/END、TEXT_BLOCK_START/DELTA/END、DATA_BLOCK_*、THINKING_BLOCK_*、HINT_BLOCK、TOOL_CALL_START/DELTA/END、TOOL_RESULT_START/TEXT_DELTA/DATA_DELTA/END、EXCEED_MAX_ITERS、REQUIRE_USER_CONFIRM、REQUIRE_EXTERNAL_EXECUTION、USER_CONFIRM_RESULT、USER_INTERRUPT、EXTERNAL_EXECUTION_RESULT、CUSTOM。CUSTOM 事件（`event/_event.py:499`）专为服务层扩展业务通知（state_updated/team_updated）设计。
- **可靠性**：`publish_session_event`（`_bus_ops.py:40`）把事件**同时**写入回放 log（Redis list，`log_append`）与 pub/sub 在线通道——SSE 订阅者可追溯历史，弥补了 pub/sub 无历史的问题（`_redis_message_bus.py:37-42` 注释明确 best-effort 语义）。

### 【Go AI 对应/差距】

- Go AI `lib/agentscope/eventMapper.ts` 的映射表与 2.0.6 事件名**完全兼容**（REPLY_START/TEXT_BLOCK_DELTA/TOOL_CALL_START/TOOL_RESULT_END/REPLY_END 均已核对存在于 `EventType`）；`TOOL_RESULT_END.state` 取值 success/error/denied/interrupted（`message/_base.py` ToolResultState）与 eventMapper 的 `ok: event.state === "success"` 判断一致。
- **差距**：go-ai `loop.ts` 的 `fromSandboxEvent`（`loop.ts:66`）面向 claude-code runtime 私有事件（tool/text/result/done/error），AgentScope runtime 不走此函数，改用 `eventMapper.ts`；两条映射链需并存（或统一为 AgentScope 事件归一）。
- AgentScope 的事件已含 `tool_call_id`/`reply_id` 等关联键，go-ai `eventMapper.ts:37-68` 手工维护的 toolNames/toolArguments/toolOutput 状态表可简化（但保留亦可）。

---

## 5. Session/State

### 【结论】

会话状态全量持久化：`AgentState`（含完整上下文 context、reply 上下文、任务上下文、权限上下文）作为 session record 的一部分存入存储（RedisStorage 或 SQL），每次 chat run 结束回写（`update_session_state`）；恢复 = 取出 session record 的 state 重建 agent 再跑。**没有"checkpoint"概念**——整个 context 就是 checkpoint；另有 workspace offload（压缩上下文/工具结果落盘可检索）作长上下文兜底。

### 【代码路径】

- `state/_state.py:176` `AgentState`：`session_id`(:179)、`summary`(:183)、`context: list[Msg]`(:187)、`reply_context`(:149)、`tasks_context`(:142 TaskContext)、`permission_context`、`middle_context`(:261)
- `state/_task.py:11` `Task`（plan 任务模型）
- `app/storage/_base.py:29` `StorageBase`：`upsert_agent`(:303)、`upsert_session`(:366)、`update_session_state`(:427)、`upsert_message`(:729)、`list_messages`(:766)
- `app/storage/_redis_storage.py:50` `RedisStorage`；`update_session_state` 实现(:947)；会话/消息的 Redis key 构造(:1417 `_message_key`)
- `app/storage/_sql/_storage.py`（SQL 实现，PostgreSQL/MySQL 等，`app/storage/_sql/_storage.py` 全文 1854 行）
- 服务侧：`app/_service/_chat.py:968` 起 `_persist`（每次回复后落盘消息+state）

### 【证据】

- `ChatService._run_impl` 从 `session_record.state` 取回 `AgentState` 注入新组装 agent（`app/_service/_chat.py:764` `agent_state = session_record.state`、`:766` `agent = self._agent_cls(..., state=agent_state)`），即**每次 run 从持久状态恢复**。
- 会话串行化用 Redis 分布式锁 `MessageBus.session_run`（`app/_service/_chat.py:220-226` 注释），跨进程单会话串行。
- 无显式 checkpoint API；`ReplyContext.reply_id/cur_iter`（`state/_state.py:149-159`）只是当次 reply 的迭代计数，不入库（回复完成后由 `update_session_state` 一并持久化 context 全量）。

### 【Go AI 对应/差距】

- Go AI `lib/tasks/job.ts:17` `JobCheckpoint`（stepSeq/loopPhase/attempt/eventCursor/lastToolResults/workspaceVersion/budgetTier/retryState）是**增量断点**；AgentScope 是**全量 context 持久化**。二者语义不同：全量恢复实现简单、成本高；Go AI 的 eventCursor/workspaceVersion 语义在 AgentScope 侧无对应。
- **必须保留**：Job 生命周期（`job.ts:12` queued→…→recovering）与 lease/heartbeat/claim（`job.ts:131/155`）——AgentScope 只有 session 锁（acquire_lock），没有 worker 租约/故障接管语义。

---

## 6. Interrupt/Cancel

### 【结论】

**完整的两级中断机制**：运行中（生成中）的 reply 通过取消 asyncio task 中断——agent 捕获 `CancelledError`，优雅关闭未完成工具调用、产出 `ReplyEndEvent(INTERRUPTED)` + 兜底消息；暂停中（HITL 等待）的 reply 通过 `UserInterruptEvent` 中断。服务层提供 HTTP `POST /sessions/{id}/interrupt`，经 Redis 消息通道广播给持有该会话 run 的进程，`CancelDispatcher` 取消本地 task。

### 【代码路径】

- agent 级：`agent/_agent.py:980` `except asyncio.CancelledError`（产出 INTERRUPTED 终态）；`:989` `interruption_raise_cancelled_error` 配置；`:808` `UserInterruptEvent` 短路径（停靠 reply）；`:694` `_close_unfinished_tool_calls`（把悬挂工具调用置 INTERRUPTED 并写回上下文）
- 工具级：`tool/_toolkit.py:370` `except asyncio.CancelledError` → `ToolResultState.INTERRUPTED`
- 事件：`event/_event.py:461` `UserInterruptEvent`
- 服务级：`app/_router/_session.py:407` `POST /sessions/{session_id}/interrupt`；`app/_service/_chat.py:388` `ChatService.interrupt`（发布 session_interrupt 通道）
- 分发：`app/_manager/_cancel_dispatcher.py:25` `CancelDispatcher`；`_interrupt_loop`(:225)/`_interrupt_session`(:243)（仅取消 chat run task，保留上下文）；`_session_cancel_loop`(:128)/`_cancel_session`(:166)（取消 run + 全部后台任务，用于删除会话/abort）
- 会话锁：`MessageBusKeys.session_lock` / `session_run`（`app/message_bus/_base.py:536`）

### 【证据】

- 运行中取消：`_reply_impl` 的 `except asyncio.CancelledError`（`:980`）构造 `ReplyEndEvent(INTERRUPTED)`，`finally` 块（`:992-1012`）先 `_close_unfinished_tool_calls` 再 yield 终态事件 + 兜底 AssistantMsg；`interruption_raise_cancelled_error=False`（默认）吞掉异常（`_config.py:322-331`）。
- 停靠中断：`UserInterruptEvent` 不进入 reasoning-acting loop，直接关闭悬挂工具调用并终态（`:808-815`）。
- 跨进程：`ChatService.interrupt` 发布 `session_interrupt_channel`（`MessageBusKeys`），各进程 `CancelDispatcher._interrupt_loop` 订阅并 `task.cancel()`（`_cancel_dispatcher.py:225-264`）——与 go-ai 已有 `client.ts:48` `interrupt` 调用完全对上。

### 【Go AI 对应/差距】

- Go AI `client.ts` 已调 `/sessions/{id}/interrupt`；事件侧 `REPLY_END(finished_reason="interrupted")` 已由 eventMapper 处理（映射为 error 分支，`eventMapper.ts:28-30`——注意：interrupted 目前会落 error，V1.5 应区分 interrupted 与 failed）。
- **无差距**：中断能力原生完备。

---

## 7. Middleware

### 【结论】

**双层中间件**：agent 级 `MiddlewareBase`（7 个钩子：on_reply/on_reasoning/on_acting/on_check_permission/on_model_call/on_compress_context/on_system_prompt，洋葱式 next_handler 链）+ 工具级 `ToolMiddlewareBase`（on_tool_call）+ 服务级扩展点（`extra_agent_middlewares` 工厂、ASGI `extra_middlewares`）。上下文注入（时间/任务/占用）、权限检查、日志/状态上报、后台卸载等都有现成中间件实现。

### 【代码路径】

- `middleware/_base.py:13` `MiddlewareBase`：钩子 `on_reply`(:68)/`on_reasoning`(:94)/`on_acting`(:117)/`on_check_permission`(:163)/`on_model_call`(:206)/`on_compress_context`(:234)/`on_system_prompt`(:257)；`is_implemented`(:55) 按实现钩子过滤
- `tool/_base.py:36` `ToolMiddlewareBase`（on_tool_call，流式/非流式统一）
- 应用内建中间件：`app/middleware/_inbox_middleware.py:24`（后台完成结果唤醒）、`_state_change_middleware.py:42`（CustomEvent 上报状态变化）、`_tool_offload_middleware.py:46`（>10s 工具转后台 + 完成唤醒）
- 通用中间件：`middleware/_rag.py`、`_budget.py`、`_tts_middleware.py`、`_longterm_memory/`（AgenticMemory/mem0/reme）、`_tracing/`
- 权限：`permission/_engine.py:17` `PermissionEngine`（模式 check：explore/accept_edits/bypass/dont_ask，:214-491；规则增删 :49；建议规则生成 :812）
- 服务级注入：`app/_app.py:95` `extra_agent_middlewares` 工厂（按 user/agent/session 产出中间件，`:199-214`）；`:374` `extra_middlewares`（ASGI）

### 【证据】

- 钩子链实现：`_reply`（`_agent.py:644-692`）、`_reasoning`（`:1279-1312`）、`_acting`（`:2357-2388`）均为"无中间件直通，有中间件洋葱链"同一模式，`next_handler` 推进下一层。
- 权限中间件与引擎：`_execute_tool_call` 中 `self._check_permission`（`_agent.py:2138`）→ `PermissionEngine.check_permission`（`permission/_engine.py:77`），支持 HITL ASK/ALLOW/DENY 决策 + 规则建议（`tool/_base.py:315` `generate_suggestions`）。
- 上下文注入：`on_system_prompt` 钩子 + `InjectionConfig`（`agent/_config.py:142`）与 `_inject_runtime_state`（`_agent.py:1014`，时间/任务/上下文占用注入为 HintBlock，不污染 system prompt 以保 prompt cache）。

### 【Go AI 对应/差距】

- Go AI 无自研 agent 中间件（策略层在 `lib/policy/capabilities.ts`），AgentScope 的钩子系统**可承接** go-ai 需要的：上下文注入（on_system_prompt）、权限（on_check_permission + PermissionEngine 规则）、审计日志（on_reply/on_acting 包装）、租户/会话隔离（extra_agent_middlewares 工厂）。
- **差距**：go-ai 的"按任务授权工具集合"（`registry.ts` authorizedTools）是执行前静态授权，AgentScope 是逐调用动态权限判定——两者语义不同但可叠加（authorizedTools 决定 toolkit 里注册哪些工具；AgentScope 权限引擎管调用时放行）。

---

## 8. Long-running / Service API

### 【结论】

`create_app` 产出完整 FastAPI 服务（15 个路由模块），覆盖 agent/chat/session/workspace/credential/model/knowledge/schedule/skill/hub/channel。**会话级并发受控**：进程内 `ChatRunRegistry` 单会话单 run（重复触发 409）+ Redis 分布式会话锁跨进程串行；长任务靠后台任务管理器（工具超时转后台 + 完成唤醒会话）+ 调度器（定时触发）。多 agent = 多会话/多 agent record 在同一 app 内并行跑，互不阻塞。

### 【代码路径】

- `app/_app.py:81` `create_app(storage, message_bus, workspace_manager, ...)`；路由注册 `:336-353`（agent/chat/credential/health/hub/knowledge_base/mcp/schedule/session/skill/workspace/model/tts_model/embedding_model/channel）；可 `root.mount("/agentscope", app)` 嵌入现有服务（`:120-128`）
- 端点（`app/_router/`）：
  - `_chat.py:49` `POST /chat/`（fire-and-forget 触发 run；接受 Msg/UserConfirmResultEvent/ExternalExecutionResultEvent/None）
  - `_session.py:189` `GET /sessions/`、`:287` `POST /sessions/`、`:366` `DELETE /sessions/{id}`、`:407` `POST /sessions/{id}/interrupt`、`:450` `PATCH /sessions/{id}`、`:562` `GET /sessions/{id}/messages`、`:645` `GET /sessions/{id}/status`、`:764` `GET /sessions/{id}/stream`（SSE）
  - `_workspace.py:53-503`：`/workspace/mcp`（GET/POST/DELETE）、`/workspace/skill`、`/workspace/directories`、`/workspace/status`、`/workspace/files`（读文件）、`/workspace/files/download-token`（带签名 token 下载）
  - `_agent.py:35-279`：agent CRUD + 列表
- 并发控制：`app/_manager/_chat_run_registry.py`（进程内单会话单 run）；`MessageBus.session_run`（跨进程锁）
- 后台任务：`app/_manager/_background_task_manager.py:216`；`app/middleware/_tool_offload_middleware.py:68-70`（timeout_secs 默认 10s 转后台）；完成回投走 `message_bus.inbox_push + enqueue_wakeup`（`_tool_offload_middleware.py:57-61`）
- 调度：`app/_manager/_scheduler/` + `_router/_schedule.py`
- 团队/子 agent：`app/_tool/_agent_create.py`、`_agent_invite.py`、`app/_tool/`（TeamCreate/TeamSay 等）

### 【证据】

- `POST /chat/` 语义为触发后立即返回（`_chat.py:53-57` 注释"fire-and-forget"），事件全部走 SSE；409 语义见 `_chat.py:100-116` 注释（registry 单 run/会话）。
- 长任务：工具超时（10s 默认）→ `ToolOffloadMiddleware` 注册后台 task（不取消原 task）→ 完成时把结果作为 `HintBlock` 推入会话 inbox 并唤醒空闲会话（`_tool_offload_middleware.py:105-140`）；`ToolStop` 工具可取消后台任务（`_background_task_manager.py:73`）。
- 多 agent：一次部署可有任意多 agent record + session；`wakeup/resume/message` 三类触发队列（`_keys.py:29-56`）支撑跨进程唤醒。

### 【Go AI 对应/差距】

- Go AI `lib/agentscope/client.ts` 已覆盖 `createSession/setPermissionBypass/triggerRun/interrupt/getMessages/getSessionStatus/stream` —— 与 2.0.6 端点契约一致。
- **差距（必须保留）**：Go AI 的 job 队列/租约/故障接管（`lib/tasks/job.ts` claimExpiredJob、worker.ts）、预算轨迹（budgetTier）、`devExecutor` 验证-修复编排——AgentScope 服务层无这些概念（其调度器是"定时触发会话"，不是任务队列）。
- **注意**：单会话单 run 限制意味着 go-ai 若要对同一 AgentScope session 并发发多个 task，需要建多 session（Go AI 现有实现已是每 task 建会话/workspace 同步，兼容）。

---

## 9. 模型调用

### 【结论】

模型层基于统一 `ChatModelBase`（消息+tools+tool_choice 输入、ChatResponse/流式输出、重试、结构化输出），具体实现用**官方 SDK**：OpenAI Chat Completions（`openai` 包，`base_url` 可覆盖）、Anthropic（`anthropic` 包，`base_url` 可覆盖）以及 dashscope/deepseek/gemini/moonshot/ollama/xai 等。**协议不锁死**：自定义模型只需继承 `ChatModelBase` 实现 `_call_api`——Go AI 的 opencode-go 通道模型（若指自研 HTTP 网关）可以子类方式接入；若指 OpenAI 兼容协议，则 `OpenAIChatModel` 改 `base_url` 直连即可。

### 【代码路径】

- `model/_base.py:36` `ChatModelBase`；`__call__`(:158，重试 :184-215)；`_call_api`(:269，抽象)；`count_tokens`(:345)；`generate_structured_output`(:433)
- `model/_openai_chat/_model.py:36` `OpenAIChatModel`；client 构造 `base_url=self.credential.base_url`(:173)
- `model/_anthropic/_model.py:27` `AnthropicChatModel`；client 构造 `base_url=self.credential.base_url`(:154)
- `model/_model_response.py` `ChatResponse`；`model/_model_usage.py` `ChatUsage`；`credential/`（OpenAICredential/AnthropicCredential 等，含 API key/org/base_url/headers）
- 服务侧：`app/_router/_model.py`、`app/_service/_model.py`（模型配置管理、fallback 解析，`app/_service/_chat.py:694-712` 解析 fallback model）

### 【证据】

- 统一入参：`ChatModelBase.__call__(messages, tools, tool_choice)`（`:158-164`）；`_reasoning_impl` 只依赖该接口（`_agent.py:1344-1350`）。
- 协议适配：`OpenAIChatModel` 走 `openai` 官方 SDK chat completions（`_openai_chat/_model.py` 全文），`AnthropicChatModel` 走 `anthropic.AsyncAnthropic().messages.create`（`_anthropic/_model.py:152-260`）——均为 SDK 原生协议，`base_url` 可指任意兼容端点（含自部署网关）。
- 流式中断：`asyncio.CancelledError` 在 `__call__` 内转为 `FinishedReason.INTERRUPTED` 的 ChatResponse（`_base.py:195-200`）。

### 【Go AI 对应/差距】

- **无协议锁死**：两种接法都可行——(a) Go AI 的 opencode-go 通道若暴露 OpenAI/Anthropic 兼容端点，直接配 `OpenAIChatModel(base_url=...)`/`AnthropicChatModel`；(b) 否则写一个 `ChatModelBase` 子类，`_call_api` 内走 Go AI 的模型网关 HTTP 通道（约 30-60 行）。
- **差距**：工具调用格式以 OpenAI/Anthropic 原生 schema 为界（`ToolCallBlock` 由各 formatter 生成，`formatter/_openai_formatter.py`、`formatter/_anthropic_formatter.py`），opencode-go 通道需与其一兼容。

---

## 10. 与 Go AI 自研模块对照

### 10.1 总表

| Go AI 模块 | 职责 | AgentScope 2.0 对应物 | 结论 |
|---|---|---|---|
| `lib/agent/loop.ts`（86 行） | UI 状态机 + 事件归一 | `Agent._reply_impl`（真实 loop）+ `event/_event.py`（26 事件） | **可替代**（真实 loop 由 AgentScope 承担；`advanceLoop` 可退化为 UI 阶段机，或直接删除） |
| `lib/tools/registry.ts`（319 行） | 工具声明/授权/执行 | `Toolkit` + `ToolBase`/`FunctionTool` + `ToolMiddlewareBase` | **部分替代**：注册/执行/schema 用 AgentScope；capabilities/授权（authorizedTools）与 JS 侧实现工具（spreadsheet 等）保留 |
| `lib/sandbox/runtimeProtocol.ts`（196 行） | ToolCall/ToolResult 归一 | AgentScope 原生事件已含 tool_call_id/name/delta/state（`TOOL_CALL_*`/`TOOL_RESULT_*`） | **大部分冗余**（仅 claude-code runtime 还需要）；eventMapper.ts 即其替代 |
| `lib/sandbox/manager.ts` | 沙箱生命周期/限额/快照 | `WorkspaceManagerBase` + `SandboxedWorkspaceBase` + `BackendBase`；Docker/OpenSandbox 实现 | **部分替代**：allocate/exec/文件操作有对应；snapshot/restore 与资源限额**无对应** |
| `lib/tasks/job.ts` | 持久 Job/会话/租约/checkpoint | `RedisStorage`（session+全量 AgentState）+ `MessageBus.acquire_lock` | **部分替代**：会话/状态持久化有对应；租约/心跳/故障接管/增量 checkpoint **无对应** |
| `lib/agentscope/eventMapper.ts` | SSE → WorkbenchEvent | 事件名/结构完全兼容（见 §4） | **保留不改**（可加 interrupted 分支） |
| `lib/sandbox/agentscopeRuntime.ts` | AgentScope 作为执行 runtime 的适配器 | 若 AgentScope 作主 harness，该适配器从"执行器"升级为"主运行时"，workspace 同步层可删 | **重构** |

### 10.2 逐项对照证据

**AgentLoop（loop.ts）**：`advanceLoop` 是纯函数状态机（`loop.ts:35-63`），无 I/O；真实循环在 AgentScope `_reply_impl`（§1）。`fromSandboxEvent`（`loop.ts:66-86`）针对 claude-code 私有事件；AgentScope 事件走 `eventMapper.ts`。V1.5 若收敛到 AgentScope 单一 harness，loop.ts 的 plan/validate/repair 阶段需由 Go AI 编排层（executor/devExecutor）保留，其余删。

**ToolRegistry（registry.ts）**：`AgentTool`（`registry.ts:33`）≈ `ToolBase`（`tool/_base.py:94`）；`runTool`（`registry.ts:287`）的超时/事件上报 ≈ `Toolkit.call_tool` + `ToolMiddlewareBase`。schema 手写 vs 自动生成（§2）。JS 侧真实实现（spreadsheet/artifact.register/browser）通过**外部工具协议**（`is_external_tool=True` + `ExternalExecutionResultEvent` 回投）接入，无需迁移到 Python。

**RuntimeToolProtocol（runtimeProtocol.ts）**：`sandboxEventToToolResult`（`runtimeProtocol.ts:89-107`）与 `eventMapper.ts` 的 `TOOL_RESULT_*` 映射功能重叠；AgentScope 事件流自带工具生命周期（START/DELTA/END + state 字段），归一函数可删。`sandboxManagerExecutor`（`:118-196`）在 AgentScope 方案下不再需要（文件/命令工具由 AgentScope 内建 Bash/Read/Write/Edit/Glob/Grep 承担）。

**SandboxManager（manager.ts）**：接口映射——`allocate`→`WorkspaceManagerBase.create_workspace`、`exec`→`BackendBase.exec_shell`、`readFile/writeFile/listFiles`→`BackendBase.read_file/write_file/list_dir`、`terminate/cleanup`→`WorkspaceBase.close`。**快照/恢复（snapshot/restore）与资源限额（SandboxLimits）在 2.0.6 无对应**（§3 差距 1/2）。

**AgentSession（job.ts）**：`AgentSessionRow`（`job.ts:177`）≈ SessionRecord（`app/storage/_base.py:366`）；会话恢复 = `session_record.state` 全量注入（§5）。**Job 租约/心跳/认领（`job.ts:131/155`）与增量 checkpoint（`job.ts:17`）无对应**——Go AI 的 worker 层必须保留，AgentScope 只管单会话串行 run。

**eventMapper（eventMapper.ts）**：事件名兼容（§4 证据），但 `REPLY_END` 的 interrupted 分支（`eventMapper.ts:29-30`）目前归入 error，V1.5 需拆出 `kind: "interrupted"`。

---

## 总判断：AgentScope 2.0 能承担 Go AI 主 Harness 吗？

### 【结论：能，但只是"部分承担"——定位为 Agent 执行引擎（loop+工具+事件+会话），Go AI 必须保留编排/租约/验收层】

**能承担的核心（V1.5 可直接替换的）**：

1. **Agent loop**：reasoning-acting 主循环、流式事件、max_iters、HITL 暂停/恢复（§1、§4）。
2. **工具系统**：注册/schema/执行/权限/中间件全套，外部工具协议天然支持 JS 侧工具接入（§2）。
3. **Workspace**：Local/Docker/远程沙箱统一抽象，容器内执行命令与文件操作（§3）。
4. **事件流**：SSE + Redis 持久回放，26 种结构化事件与 go-ai eventMapper 兼容（§4）。
5. **会话持久化**：全量 AgentState 入库、跨进程串行锁、断点即上下文（§5）。
6. **中断**：运行中取消（CancelledError 优雅处理）与停靠中断（UserInterruptEvent）双路径 + HTTP interrupt 端点（§6）。
7. **模型**：OpenAI/Anthropic 官方协议 + base_url 可覆盖，或子类化接入自研网关（§9）。

**必须保留在 Go AI 侧的关键缺口清单**（AgentScope 2.0.6 无对应物）：

1. **Job 队列与租约/故障接管**：`lib/tasks/job.ts` 的 queued→recovering 状态机、heartbeat/lease、claimExpiredJob——AgentScope 只有会话锁，无 worker 租约与任务级重试语义。
2. **增量 checkpoint 与 workspace 版本化**：`JobCheckpoint.eventCursor/workspaceVersion`、`SandboxProvider.snapshot/restore`——AgentScope 是全量上下文持久化 + 无版本化。
3. **validate/repair 验收编排**：`lib/tasks/devExecutor.ts`/`executor.ts` 的执行后验收-修复循环——AgentScope 无此语义（只有 max_iters 与结构化输出）。
4. **沙箱资源限额**：`SandboxLimits`（内存/CPU/pids/超时）在 DockerWorkspace 公开 API 未暴露，若生产要求 per-task 限额需自管容器或提交 upstream。
5. **JS 侧工具真实实现**：spreadsheet/artifact.register/browser 等仍是 TypeScript 代码——通过外部工具协议（`is_external_tool=True` + `REQUIRE_EXTERNAL_EXECUTION`/`EXTERNAL_EXECUTION_RESULT` 事件对）桥接，Go AI 需实现该事件对的中转服务。
6. **任务 workspace 布局约定**：`agentscopeRuntime.ts` 的 input/working/output 同步层——若改用 AgentScope 托管 workspace 可删，否则保留。
7. **预算/审计策略层**：`lib/policy/` 的 capabilities 授权、budgetTier 轨迹——可映射到 AgentScope 的 toolkit 注册裁剪 + `on_check_permission` 中间件，但映射工作属于 Go AI。

**架构建议**：AgentScope 2.0 适合作为"**Agent 引擎进程**"（agent loop + 工具 + workspace + 事件 + 会话存储），Go AI 保留"**编排层**"（job/租约/验收/产物/预算）——二者经现有 HTTP 契约（`POST /chat/` + SSE + `interrupt` + 外部工具事件对）耦合，Go AI 现有 `AgentScopeRuntimeAdapter` + `client.ts` 即为雏形，V1.5 是把该运行时从"可选执行器"提升为"主执行引擎"，并补上外部工具事件对的中转。

---

*审计完成时间：2026-08-16。所有结论均基于 `pip show agentscope` 定位的 2.0.6 安装目录源码逐行核对；未安装处不臆测。*
