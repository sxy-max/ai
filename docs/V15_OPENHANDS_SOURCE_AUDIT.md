# OpenHands Agent SDK 源码审计（Go AI V1.5 备选 Harness）

> 审计对象：`openhands-ai`（PyPI，v0.37.0，sdist 全量源码，290 个 .py 文件）
> 源码位置：`D:\codex\research-cloud-agent\repos\openhands-pypi\openhands_ai-0.37.0\openhands\`
> 审计日期：2026-08-16
> 方法：pip download sdist 解包 + 逐文件精读，非 README 层。GitHub 两个目标仓库均已浅克隆验证（见 §0）。

---

## 0. 源码获取事实（先读这个，影响后续一切）

| 目标 | 结果 |
|---|---|
| `pip install openhands-ai` | 可行，PyPI 最新 0.37.0；**本机 Python 3.14 不满足 `python = "^3.12"`（pyproject.toml），实测只能 pip download 解包** |
| `software-agent-sdk`（PyPI） | 不存在 |
| `github.com/All-Hands-AI/software-agent-sdk` | 仓库不存在（404） |
| `github.com/All-Hands-AI/OpenHands`（main，HEAD `0d15c5e`） | **已无 Python 后端**——主仓库现为 Agent Canvas 前端（Electron/TypeScript），根目录只有 `src/`、`electron/` 等，无 `openhands/` 包 |

**结论**：OpenHands 的 Python Agent SDK 现在只以 `openhands-ai` PyPI 包形式分发（sdist 内含完整 `openhands/` 包）；GitHub 主仓库 HEAD 已是前端，Python 代码不在任何 named branch（`git ls-remote` 验证）。做架构决策/版本追踪必须以 pip 包为准，不要 clone GitHub。

---

## 1. Agent loop 谁负责

【结论】事件驱动的循环，由 `AgentController` 驱动：LLM step → Action 入 EventStream → Runtime 执行 → Observation 入流 → 控制器收到 Observation 决定是否再 step。没有显式 plan/think/act 三阶段状态机；"思考"是 CodeActAgent 的一个工具（AgentThinkAction，非 runnable，仅记日志）。

【代码路径】
- `openhands/controller/agent_controller.py`
- `openhands/core/loop.py`
- `openhands/controller/agent.py`（抽象 Agent）
- `openhands/agenthub/codeact_agent/codeact_agent.py`（默认 agent 实现）

【证据】
- 单步核心：`AgentController._step()`（agent_controller.py:771-892）。前置检查：state 必须 RUNNING（L773-779）、无 pending action（L781-789）、traffic control 限流（L797-810）、stuck 检测（L812-816）；然后 `action = self.agent.step(self.state)`（L827，同步阻塞调用 LLM）；`self.event_stream.add_event(action, action._source)`（L887）把 Action 发给 Runtime。
- 循环推进不是 `while`，而是事件回调：控制器订阅 EventStream（`AgentController.__init__`，L148-151，subscriber=AGENT_CONTROLLER）；`on_event`（L373-398）→ `_on_event`（L400-430）→ `should_step()`（L334-371）判断"收到 Observation 就再走一步"，`_step_with_exception_handling`（L303-332）异步执行。
- 外层兜底：`run_agent_until_done(controller, runtime, memory, end_states)`（core/loop.py:10-45）每秒轮询 `controller.state.agent_state not in end_states`，终态集合 = FINISHED/REJECTED/ERROR/PAUSED/STOPPED（core/main.py:183-189）。
- action→observation 模型：`Action` 带 `runnable` 标志（events/action/action.py:22-23）；`Observation.cause` 回指触发它的 Action id（events/event.py:74-79）；Runtime 执行后 `observation._cause = event.id`（runtime/base.py:302）。
- 无 plan 阶段：CodeActAgent.step（codeact_agent.py:141-213）直接 `self.llm.completion(messages, tools)` → `response_to_actions` → 返回 Action；ThinkTool → AgentThinkAction（function_calling.py:175-176），`Runtime.run_action` 对非 runnable 的 think 返回 AgentThinkObservation（runtime/base.py:602-605）。长上下文截断（CondensationAction，agent_controller.py:1156-1193）和 delegate 子代理（start_delegate，L662-712）是仅有的两个"中间状态"。
- Agent 抽象：`Agent.step(state) -> Action`（controller/agent.py:98-103）；注册表 `Agent.register/get_cls/list_agents`（L120-161）；`get_system_message()` 生成 SystemMessageAction（L54-87）。

【Go AI 对应/差距】Go AI `lib/agent/loop.ts` + `runner.ts` 的 AgentLoop ↔ `AgentController._step` + `run_agent_until_done`；Go AI 的 loop 是 TS 显式 while（更可控），OpenHands 是"事件流 + 轮询 + 内部回调队列"三件套（queue thread + asyncio + per-subscriber ThreadPoolExecutor，见 §4），并发模型更复杂。差距：OpenHands 无 plan 阶段、无 ReAct 状态机；step 是同步阻塞的（LLM 调用期间整条链卡住）。

---

## 2. Tool 系统

【结论】没有独立的 ToolRegistry/ToolCallAction。工具 = litellm `ChatCompletionToolParam` 定义（纯 schema），模型 tool_call 经 `response_to_actions` 的 if/elif 链转成具体 Action 子类。自定义工具三条路：改 CodeActAgent 的 tools 列表 + 映射链、写自定义 Agent 子类、MCP 工具动态注入。

【代码路径】
- 工具定义：`openhands/agenthub/codeact_agent/tools/*.py`（bash.py / browser.py / finish.py / ipython.py / llm_based_edit.py / str_replace_editor.py / think.py / web_read.py）
- 调用转换：`openhands/agenthub/codeact_agent/function_calling.py`
- Action 类型全集：`openhands/events/action/__init__.py`
- MCP：`openhands/mcp/__init__.py`、`events/action/mcp.py`

【证据】
- Action 类型（events/action/__init__.py:1-41）：`CmdRunAction`（bash，commands.py:13）、`IPythonRunCellAction`（commands.py:41）、`FileReadAction/FileWriteAction/FileEditAction`（files.py）、`BrowseURLAction/BrowseInteractiveAction`（browse.py）、`AgentFinishAction/AgentRejectAction/AgentDelegateAction/AgentThinkAction/ChangeAgentStateAction/RecallAction/CondensationAction`（agent.py）、`MessageAction/SystemMessageAction`（message.py）、`MCPAction`（mcp.py）、`NullAction`。
- 工具→Action 映射是硬编码 if/elif 链：`response_to_actions(response, mcp_tool_names)`（function_calling.py:55-238）。例：`execute_bash` → CmdRunAction（L87-94）、`finish` → AgentFinishAction（L114-118）、`str_replace_editor` view→FileReadAction/edit→FileEditAction（L138-171）、`think` → AgentThinkAction（L175-176）、`browser` → BrowseInteractiveAction（L181-186）、MCP 名 → MCPAction（L201-205）。每个 Action 挂 `ToolCallMetadata`（events/tool.py:5-11：function_name/tool_call_id/model_response）。
- 工具装配：`CodeActAgent._get_tools()`（codeact_agent.py:102-134）按 AgentConfig 开关（enable_cmd/enable_think/enable_finish/enable_browsing/enable_jupyter/enable_llm_editor/enable_editor）拼 tools 列表；`step()` 时 `params['tools'] = self.tools`（L186）。
- MCP 动态注入：`add_mcp_tools_to_agent(agent, runtime, config.mcp)`（mcp/__init__.py），Agent.set_mcp_tools（controller/agent.py:163-183）把 MCP 工具 append 进 `self.tools`；执行路径 `Runtime._handle_action` 里 MCPAction 走 `call_tool_mcp`（runtime/base.py:286-287），经 SSE 连回 runtime 内嵌的 MCP router（action_execution_client.py:329-357）。
- 自定义工具没有注册表：要么改 `function_calling.py` 的 if/elif 链，要么写新 Agent 子类并 `Agent.register(name, cls)`（controller/agent.py:120-133）。

【Go AI 对应/差距】Go AI `lib/tools/registry.ts`（注册表模式）↔ OpenHands 没有等价物——OpenHands 的工具是"prompt schema + 硬编码映射"，加一个工具要改两处代码（或走 MCP）。差距：OpenHands 的 ToolRegistry 更弱（无运行时注册/无 schema 校验中心，FunctionCallValidationError 只是 JSON parse + 参数存在性检查，function_calling.py:77-91）。

---

## 3. Runtime/Sandbox

【结论】`Runtime` 抽象基类定义执行入口（run/run_ipython/read/write/browse/browse_interactive/call_tool_mcp），实现有 docker（默认）/local/e2b/modal/remote/runloop/daytona。运行时本身订阅 EventStream 消费 Action 并回写 Observation。沙箱隔离只有 Docker/云提供商路径；LocalRuntime 明确无沙箱（tmux + 宿主机执行）。执行进程是独立 HTTP 服务 `action_execution_server`（容器内或本机子进程），客户端 `ActionExecutionClient` 通过 `/execute_action` 下发。

【代码路径】
- `openhands/runtime/base.py`、`openhands/runtime/__init__.py`（注册表）
- `openhands/runtime/impl/{docker,local,remote,daytona,e2b,modal,runloop}/`
- `openhands/runtime/impl/action_execution/action_execution_client.py`
- `openhands/runtime/action_execution_server.py`
- `openhands/runtime/utils/bash.py`、`openhands/runtime/browser/browser_env.py`

【证据】
- 抽象入口（runtime/base.py:639-673）：`run(CmdRunAction)`、`run_ipython(IPythonRunCellAction)`、`read/write`、`browse/browse_interactive`、`call_tool_mcp`；`run_action(action)` 统一分发（L597-627）：按 `action.action` 字符串 `getattr(self, action_type)` 动态调用。
- 事件驱动执行：`Runtime.__init__` 里 `event_stream.subscribe(RUNTIME, self.on_event, sid)`（L121-123）；`on_event` → `_handle_action`（L279-310）：设硬超时 → 执行 → `observation._cause = event.id` → `event_stream.add_event(observation, source)`。
- 注册表（runtime/__init__.py:17-30）：eventstream/docker→DockerRuntime、e2b、remote、modal、runloop、local、daytona；`get_runtime_cls` 也支持自定义子类名。
- DockerRuntime（impl/docker/docker_runtime.py:62）：每会话一个容器 `openhands-runtime-{sid}`（L33），docker SDK 拉 `runtime_container_image`，容器内跑 action_execution_server；端口段 30000-39999（执行服务器）/40000-49999（VSCode）/50000-59999（app）。
- LocalRuntime（impl/local/local_runtime.py:90-343）：**明确警告 NO SANDBOX**（L133-142，"this is an experimental feature…NO SANDBOX IS USED"）；`connect()`（L185-264）在本机 spawn action_execution_server 子进程（get_action_execution_server_startup_command），HTTP 代理；依赖检查要 tmux/jupyter（L44-87）。
- ActionExecutionClient（impl/action_execution/action_execution_client.py:55-390）：`send_action_for_execution`（L244-306）POST `/execute_action`；`run/run_ipython/read/write/edit/browse` 全部走它（L308-327）；另有 `/list_files`、`/upload_file`、`/download_files`、`/update_mcp_server`、`/vscode/connection_token`。
- action_execution_server.py：FastAPI，`POST /execute_action`（L721-737，action JSON → `client.run_action` → observation JSON），`/alive`（L868），鉴权 `X-Session-API-Key`（L694-704）。
- Bash 入口：`BashSession` 基于 libtmux 持久 tmux session（runtime/utils/bash.py:10,169-214），支持 is_input 交互、C-c 中断、120s 软超时（bash.py:8）；exit_code -1 表示进程未结束。
- 浏览器入口：`BrowserEnv`（runtime/browser/browser_env.py:30）基于 BrowserGym，multiprocessing Pipe 隔离（L58-59），BrowserOutputObservation 返回（dom/screenshot/som overlay）。
- 安全层：`security/analyzer.py` SecurityAnalyzer（Invariant）订阅事件流审查 Action（confirmation_mode 时 CmdRunAction/IPythonRunCellAction 需确认，agent_controller.py:868-873）。

【Go AI 对应/差距】Go AI `lib/sandbox/manager.ts`（多 provider adapter）+ `lib/sandbox/runtimeProtocol.ts` ↔ `Runtime` 基类 + 实现注册表；Go AI `services/agent-runtime/main.py`（Python 执行服务）↔ `action_execution_server.py`（同为 HTTP execute_action 协议，结构几乎一一对应——可以互证协议设计）。差距：OpenHands 无本地安全沙箱（LocalRuntime 裸跑宿主），且 bash 强依赖 tmux；Go AI 的 dockerClaudeCode/localProvider 适配器模式比 OpenHands 的多态继承更轻。

---

## 4. 事件流

【结论】`EventStream`（进程内）+ `FileStore` 文件持久化（每事件一个 JSON + 25 条一页缓存）。订阅者回调模型：per-subscriber 线程池 + asyncio。对外实时通道是 **Socket.IO**（`oh_event` 房间），本版本无 SSE 端点；断线重连按 `latest_event_id` 从文件重放。外部进程监听：进程内用 `EventStreamSubscriber` 枚举，跨进程用 Socket.IO 或直接读存储文件。

【代码路径】
- `openhands/events/stream.py`、`openhands/events/event_store.py`
- `openhands/storage/`（local.py / s3.py / google_cloud.py）、`openhands/storage/locations.py`
- `openhands/server/listen_socket.py`、`openhands/server/listen.py`

【证据】
- 订阅者枚举（stream.py:23-31）：`EventStreamSubscriber = AGENT_CONTROLLER / SECURITY_ANALYZER / RESOLVER / SERVER / RUNTIME / MEMORY / MAIN / TEST`。
- 进程内订阅：`EventStream.subscribe(subscriber_id, callback, callback_id)`（stream.py:125-143）为每个订阅者建 ThreadPoolExecutor(1) + 独立 asyncio loop；`add_event`（L158-189）先写文件再入 `queue.Queue`；`_process_queue`（L224-245）逐个回调。
- 持久化：`EventStore`（event_store.py:42-288）——`get_events(start_id, end_id, reverse, filter_out_type, filter_hidden)`（L82-138）按 id 区间从文件读；文件名 = `{conversation_dir}/{sid}/event/{id}.json`（locations.py），page cache 每 25 条一个 `event_cache/{start}-{end}.json`（event_store.py:262-263）。`cur_id` 启动时扫描目录恢复（L53-80）。事件序列化：`event_to_dict/event_from_dict`（events/serialization/event.py）。
- 存储后端：`get_file_store(file_store_type, path)`，local 默认 `/tmp/openhands_file_store`（core/config/app_config.py:61），可选 s3/gcp。
- 跨进程：Socket.IO connect 时带 `conversation_id` + `latest_event_id` 参数（listen_socket.py:44-56），服务端 `AsyncEventStoreWrapper(event_stream, latest_event_id+1)` 重放（L99-112）；之后所有事件经 `sio.emit('oh_event', event_to_dict(event))` 推送（L110、session.py:267）。用户消息经 `oh_user_action` 收（listen_socket.py:116-118）。
- 无 SSE：全库 grep 无 `EventSourceResponse/text/event-stream`；`server/listen.py:34` 直接挂 `socketio.ASGIApp`。前端的 `python-socketio` 客户端与 REST 并存。
- 事件进入 EventStream 时的密钥打码：`_replace_secrets`（stream.py:207-214，`<secret_hidden>`）。

【Go AI 对应/差距】Go AI 无事件流层（loop 直出 stdout/回调）↔ OpenHands 的核心资产就是这层（事件溯源 + 断点重放 + 多订阅者）。差距：OpenHands 没有订阅持久化队列（断连即丢推送，靠文件重放补齐）；SSE 缺失（Go AI 若想 HTTP 推送得自己包 Socket.IO 或加 SSE 端点）；多线程+asyncio 混用模型（stream.py 里 run_until_complete 嵌套）在 Go AI 的 Node 单线程模型里无对应物。

---

## 5. Session/长任务

【结论】会话 = `AgentSession`（server 层）+ `State`（pickle+base64 落盘）+ EventStream 文件（全量事件溯源）。恢复 = `State.restore_from_session` 找回迭代/预算/指标 + 控制器从 event_stream 重建 history + runtime `attach_to_existing` 复用容器。任务模型是 `Task/RootTask` 树（open/completed/abandoned/in_progress/verified），不是对话数组。

【代码路径】
- `openhands/server/session/agent_session.py`、`server/session/session.py`
- `openhands/controller/state/state.py`、`openhands/controller/state/task.py`
- `openhands/server/conversation_manager/standalone_conversation_manager.py`

【证据】
- `AgentSession.start()`（agent_session.py:78-189）：创建 runtime→security analyzer→MCP 工具→controller（`_create_controller`，L343-400，`initial_state=self._maybe_restore_state()` L396）→memory→发初始 MessageAction（L167-172）。
- 恢复：`_maybe_restore_state`（agent_session.py:426-444）调 `State.restore_from_session(sid, file_store, user_id)`（state.py:131-170）：读 pickle 文件 → `agent_state=LOADING`、`resume_state=原状态`（RESUMABLE_STATES=RUNNING/PAUSED/AWAITING_USER_INPUT/FINISHED，L36-41）→ 控制器 `_init_history` 从 EventStream 按 start_id/end_id 重建 history（agent_controller.py:1060-1154，含 delegate 区间裁剪）。pickle 时排除 history（state.py:172-182），由事件流重建。
- 保存：`State.save_to_session`（state.py:109-129）base64(pickle(state)) 写 `{conversation_dir}/{sid}/agent_state.json`；`AgentSession.close`（agent_session.py:191-215）和 `core/main.py:197-202` 结束时保存。
- 任务树：`RootTask/Task`（task.py:33+）id 分层（`parent.id + '.' + len(subtasks)`），状态机 open/completed/abandoned/in_progress/verified（L9-18）。
- 会话生命周期管理：`StandaloneConversationManager`（standalone_conversation_manager.py:36-473）——`attach_to_conversation` 复用活跃/detached 会话（L66-110）、`maybe_start_agent_loop`（L248-270）、`_cleanup_stale` 15s 清扫（L149-194）、并发上限 `max_concurrent_conversations`（L283-314）。
- 会话元数据（成本/token/更新时间）：`ConversationStore` 持久化（storage/conversation/），事件流 SERVER 订阅者回调更新（standalone_conversation_manager.py:427-466）。

【Go AI 对应/差距】Go AI `lib/agent/jobStore.ts`（job 持久化）↔ State+ConversationStore；Go AI 的 AgentSession 概念 ↔ `AgentSession`。差距：OpenHands 没有 git checkpoint（只有状态文件+事件文件+容器 attach）；pickle 序列化与 Python 强绑定，Go/Node 侧做不了跨语言解析，只能通过 trajectory JSON（`controller.get_trajectory()`，agent_controller.py:1052-1058）或事件 JSON 交换。

---

## 6. Interrupt/Cancel

【结论】停止 = 向 EventStream 注入 `ChangeAgentStateAction(STOPPED)`（或 ERROR），控制器 `set_agent_state_to` 切换状态机并 `_reset()`；粒度是 step 之间（无法中断 in-flight LLM 调用）。另有两级自动刹车：迭代/预算 traffic control、stuck 检测。

【代码路径】
- `openhands/controller/agent_controller.py`（set_agent_state_to / _reset / _handle_traffic_control / _is_stuck）
- `openhands/controller/stuck.py`、`openhands/controller/state/state.py`
- `openhands/cli/commands.py`（/exit、/stop）

【证据】
- 状态机：`set_agent_state_to`（agent_controller.py:585-652）：STOPPED/ERROR 时先合并 metrics 再 `_reset()`（L599-603）；`_reset`（L552-583）清 pending action、给未完成的 runnable action 补 ErrorObservation（ERROR_ACTION_NOT_EXECUTED，L80）、`self.agent.reset()`；状态变更发 AgentStateChangedObservation（L649-652）。
- 阻断再步进：`_step` 开头 `if self.get_agent_state() != RUNNING: return`（L773-779）、`if self._pending_action: return`（L781-789）。
- 外部停止入口：`ChangeAgentStateAction` 由控制器 `_handle_action` 直接转发（L434-435）；CLI `/exit`/`/stop` 发出该事件（cli/commands.py:94、160）；web 端同样经 Socket.IO `oh_user_action` → `session.dispatch` → `event_stream.add_event(event, USER)`（session.py:238-254）。
- 自动刹车：`_handle_traffic_control`（agent_controller.py:901-941）——超过 `max_iterations` 或 `max_budget_per_task` 后 THROTTLING；headless 模式直接转 ERROR（L927-932）。`_is_stuck` → `StuckDetector`（stuck.py）→ AgentStuckInLoopError。
- 超时：动作级硬超时 `set_hard_timeout`（events/event.py:86-101），默认 `sandbox.timeout`（runtime/base.py:280-283）；HTTP 层 `timeout=action.timeout+5`（action_execution_client.py:296）。

【Go AI 对应/差距】Go AI runner 的 cancel 逻辑（abort in-flight）↔ OpenHands 只能 step 间停。差距：无 in-flight LLM 中断（LLM 调用是同步阻塞的，CancelledError 不会打断 litellm）；无任务级 cancel API（要自己发 ChangeAgentStateAction）。

---

## 7. 可编程调用（外部进程驱动单次任务）

【结论】**可以外部驱动**，三条现成路径，均支持非交互式：
1. **Python API（推荐）**：`run_controller(config, initial_user_action)`——headless 单跑一任务，返回终态 `State`（含 outputs/metrics/history），可 `--save-trajectory-path` 导出 trajectory JSON。
2. **CLI 子进程**：`python -m openhands.core.main -t "task" [--save-trajectory-path ...]`（该入口无 TUI，跑完退出）；交互式 CLI 是 `python -m openhands.cli.main`。
3. **HTTP/Socket.IO 服务**：起 FastAPI 服务，客户端用 python-socketio 连 `conversation_id`，发 `oh_user_action`，收 `oh_event` 全量事件流，发 ChangeAgentStateAction(STOPPED) 停；REST 侧有会话管理/文件/配置路由。
另有第 4 条低层通道：直接调 runtime 的 `action_execution_server` HTTP API（`/execute_action`）——绕开 LLM 循环，仅执行动作。

【代码路径】
- `openhands/core/main.py`（run_controller L48-220；无头入口 __main__ L263-297）
- `openhands/core/setup.py`（create_agent/create_controller/create_runtime L37-）
- `openhands/cli/main.py`、`openhands/cli/commands.py`
- `openhands/server/app.py`、`server/listen_socket.py`、`server/routes/manage_conversations.py`
- 依赖注意：`python = "^3.12"`（pyproject.toml），本机 3.14 装不上——部署需独立 venv 或镜像。

【证据】
- `run_controller` 签名（core/main.py:48-58）：`(config, initial_user_action: Action, sid, runtime, agent, exit_on_message, fake_user_response_fn, headless_mode=True, memory) -> State | None`。内部：create_runtime→connect→MCP 注入→create_controller→`event_stream.add_event(initial_user_action, USER)`（L167）→`run_agent_until_done`（L192）→`controller.close()`（L204）→trajectory 落盘（L209-218）→返回 state。`fake_user_response_fn`（L169-179 的 on_event）解决 agent 想反问用户的场景（默认 `auto_continue_response` L223-236 让 agent 自行决定继续或收尾）。
- 无头 CLI：core/main.py:263-297——`-t/-f` 任务、`--name` 会话名、`--no-auto-continue`、`--save-trajectory-path`、`--save-screenshots-in-trajectory`；退出码靠状态判断。
- 服务端：`listen_socket.py:44-113` connect 重放 + `oh_user_action`（L116-118）收用户动作；`manage_conversations.py` 提供 REST（创建/列表/历史/删除会话）；`conversation.py` 提供 runtime 配置/vscode-url/web-hosts。
- 会话隔离与并发：每 sid 一个 EventStream + Runtime；manager 复用活跃会话（standalone_conversation_manager.py:66-110）。

【Go AI 对应/差距】Go AI worker 是 Node.js：**推荐方案 = 子进程调用无头 CLI 或 Python sidecar 调 run_controller，用 trajectory JSON + 退出状态收结果**；跨语言实时监听用 Socket.IO 客户端（Node 有 socket.io-client）或轮询事件文件。差距：没有官方 REST "run task and return result" 端点（server 层假设前端挂 Socket.IO）；服务端还绑定前端 SPA（listen.py:13-15，可 `SERVE_FRONTEND=false` 关）；python-socketio 与 Node 交互无类型契约（事件 JSON schema 非正式版）。

---

## 8. 模型调用

【结论】`LLM` 类薄封装 litellm.completion，OpenAI 兼容协议 + 任意 litellm provider（base_url/api_key/custom_llm_provider/azure/openrouter/ollama 均可配）；自带重试（指数退避）、成本/Token 度量、prompt caching 标记、function-calling 模型白名单、reasoning_effort。

【代码路径】
- `openhands/llm/llm.py`、`openhands/llm/llm_config.py`（在 core/config 下）
- `openhands/llm/metrics.py`、`openhands/llm/retry_mixin.py`
- `openhands/core/config/llm_config.py`

【证据】
- `LLM.__init__`（llm.py:106-186）：`self._completion = partial(litellm_completion, model=..., api_key=..., base_url=..., api_version=..., custom_llm_provider=..., timeout=..., top_p=..., drop_params=..., seed=...)`（L172-186）——base_url 设自定义网关即 OpenAI 兼容接入。
- `LLMConfig`（core/config/llm_config.py:12-88）：model（默认 claude-3-7-sonnet-20250219，L49）、base_url/api_key/api_version/aws/ollama_base_url/openrouter_site_url、num_retries=4+指数退避（L59-63）、temperature=0/top_p=1/max_output_tokens、drop_params=True、caching_prompt=True、disable_vision、reasoning_effort（o1/o3/o4 系列，L80-89）、custom_tokenizer。TOML 多 LLM 分组 `[llm.xxx]`（L90-152）。
- 模型能力判定：FUNCTION_CALLING_SUPPORTED_MODELS（llm.py:60-78）、CACHE_PROMPT_SUPPORTED_MODELS（L50-57）；`format_messages_for_llm`（llm.py:200+）处理角色/工具消息。
- 多 agent 各配 LLM：`agent_to_llm_config`（agent_controller.py:160, start_delegate L680-682）；delegate 用子 LLM 配置。
- 度量：Metrics/TokenUsage（llm/metrics.py），控制器把指标附到 Action 上（agent_controller.py:1334-1394），会话元数据同步成本（standalone_conversation_manager.py:449-464）。

【Go AI 对应/差距】Go AI 的 LLM 客户端层（OpenAI 兼容直连）↔ litellm（更强：Azure/vertex/openrouter/ollama + 成本表 + 重试，但依赖重、升级快、版本锁 `^1.60.0`）。差距：无，模型调用是 OpenHands 最容易替代的部分；若 Go AI 已直连 OpenAI 兼容 API，此层可完全绕开（OpenHands 不强求用它的 LLM 类——Agent 子类可自实现 step）。

---

## 9. 与 Go AI 自研模块对照表

| Go AI 模块（D:\Projects\go-ai） | OpenHands 原生对应物 | 差距 |
|---|---|---|
| `lib/agent/loop.ts`（AgentLoop） | `controller/agent_controller.py::AgentController._step` + `core/loop.py::run_agent_until_done` | OpenHands 事件驱动+轮询，Go AI 显式循环；均无 plan 阶段 |
| `lib/agent/runner.ts` | `core/main.py::run_controller`（headless 单跑） | 等价，OpenHands 返回 State+trajectory |
| `lib/tools/registry.ts`（ToolRegistry） | **无注册表**；工具=prompt schema+`function_calling.py` 硬编码 if/elif 链；MCP 动态注入 | OpenHands 更弱：加工具改两处代码，无 schema 中心校验 |
| `lib/sandbox/manager.ts` + `adapter.ts`（SandboxManager） | `runtime/__init__.py` 注册表 + `runtime/impl/*`（docker/local/remote/e2b/modal/runloop/daytona） | OpenHands 默认 Docker 每会话一容器；Local 无沙箱 |
| `lib/sandbox/runtimeProtocol.ts`（RuntimeToolProtocol） | `runtime/impl/action_execution/action_execution_client.py` + `runtime/action_execution_server.py`（HTTP `/execute_action`，action/observation JSON） | **协议高度同构**，可互证设计 |
| `services/agent-runtime/main.py` | `runtime/action_execution_server.py`（容器内执行服务） | 结构几乎一一对应 |
| `lib/agent/jobStore.ts`（AgentSession/job 持久化） | `server/session/agent_session.py` + `controller/state/state.py::State.save/restore` + `events/event_store.py` | OpenHands 是事件溯源+pickle 状态；Go AI 是 JSON job |
| — | OpenHands 独有：多代理 delegate（`AgentDelegateAction`，agent_controller.py:662-769）、对话压缩 Condenser（memory/condenser/）、microagents 记忆（memory/memory.py + microagent/）、安全审查（security/analyzer.py）、traffic control（迭代/预算）、stuck 检测 | Go AI 无对应物（可按需借用设计） |

---

## 10. 结论：作为 Go AI 主 Harness 的可行性

**判定：部分可行（能作 Worker 型 Harness，不宜整机移植）。**

### 支持"外部进程驱动单次任务执行"（关键问题）——是，三条路径已验证源码：
1. **无头 CLI/子进程**：`python -m openhands.core.main -t "<task>" --save-trajectory-path out.json`（core/main.py:263-297），跑完退出，trajectory JSON + 退出码收结果——最适合 Go AI worker 嵌 Node 子进程。
2. **Python API**：`await run_controller(config, MessageAction(task))` 返回终态 State（core/main.py:48-220），配 `fake_user_response_fn` 全自动应答（L169-179、L223-236）。
3. **Socket.IO 服务**：`sio.connect(conversation_id, latest_event_id)` → `oh_user_action` 发任务、`oh_event` 收全量事件、ChangeAgentStateAction(STOPPED) 停止（listen_socket.py:44-131）——适合 Go AI 需要实时监控/日志流的场景（Node 有 socket.io-client）。
   4. 低层：`action_execution_server` HTTP `/execute_action`（L721-737）可绕过 LLM 循环单独执行动作（沙箱 API 化）。

### 关键缺口 / 风险（按重要性）：
1. **Python 环境**：要求 `python ^3.12`（pyproject.toml），本机 3.14 无法安装；依赖 litellm 全家桶，体积大。Go AI 侧需独立 venv/容器镜像，进程级集成（子进程协议），无法 in-process。
2. **代码源漂移**：GitHub 主仓库 HEAD 已无 Python 后端（Agent Canvas 前端接管），SDK 只活在 PyPI sdist——版本追踪/补丁 fork 都要基于 pip 包，且 0.37.0 是"最后快照"，后续大版本变化不可控。
3. **沙箱默认不可用**：LocalRuntime 无沙箱（裸宿主机 tmux，local_runtime.py:133-142 明示警告）；安全隔离只有 Docker/云 runtime。Go AI 若采用，必须部署其 Docker runtime 镜像。
4. **无 SSE/无 REST 任务端点**：跨进程事件只能 Socket.IO 或文件轮询；官方 server 绑定前端 SPA（可用 `SERVE_FRONTEND=false` 关）。
5. **停止粒度**：step 间停止，不能中断 in-flight LLM 调用；无任务级 cancel API。
6. **状态序列化 pickle**：与 Python 强绑定，Go 侧只能消费 trajectory/事件 JSON，不能复用状态文件。
7. **agent 反问用户**：默认头less 会自动继续（auto_continue_response），但依赖 `wait_for_response` 语义，需要测试确认长任务不挂起。

### 建议（供 V1.5 决策参考）：
- OpenHands 作 **worker 内部候选 Harness**（非 UI 平台）成立：单任务无头 CLI + trajectory JSON 收口 + Docker runtime 隔离，和 Go AI 现有 `services/agent-runtime` 协议几乎同构（§9 对照），替换成本主要是"事件流语义"（OpenHands 的 Action/Observation 与 Go AI 的 RuntimeToolProtocol 消息对齐）。
- 若 V1.5 优先事项是"多语言多 Harness 统一入口"（类似 Agent Canvas 思路），OpenHands 的 SDK 反而不是最优（它是单语言、自包含状态机）；若优先事项是"获得成熟的 coding agent 能力（bash/浏览器/文件编辑/上下文压缩）"，OpenHands 是当前开源里完成度最高的候选，但需接受上述 7 个缺口。
- 落地第一步建议：在 Linux 容器里 `pip install openhands-ai==0.37.0`，用无头 CLI 跑通"任务→trajectory JSON→退出"最小闭环，再决定是否进 worker。
