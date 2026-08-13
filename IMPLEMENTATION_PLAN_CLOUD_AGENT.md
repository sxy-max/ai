# Go AI Cloud Agent Workspace 实施计划

> 日期：2026-08-13 ｜ 依赖排序，非随意排期。每个 Phase 都是「可独立验收、不破坏现有 chat」的增量。
> 总原则：**先收敛为模块，再补状态机，最后做 UI 与稳定化**。第一阶段先做 Task Router（零风险、解锁所有后续路由），再按依赖推进。
> 现状基础：`lib/vision.ts`、`lib/message/types.ts`、`lib/toolRegistry.ts`、artifact 磁盘雏形、`agent/task` NDJSON 代理均已存在——各 Phase 尽量改造而非重写。

---

## Phase A：Task Router + Task Types

**目标**：建立 `TaskType = chat | artifact | agent_workspace` 的单一决策源，从 `page.tsx` 抽离路由判断到服务端模块；为后续所有 Phase 提供统一入口。

**为什么先做**：路由是地基——没有它，artifact/agent 链路无法被正确触发；且它是最小、零风险改动（纯判定，不动执行），能立刻收敛当前散落在前端的分叉。

**涉及模块**：Task Router（#1）、Tool Registry（沿用）。

**参考设计**：Open WebUI 的「显式 tool 声明 + 参数白名单」思路（`backend/open_webui/utils/tools.py`）；OpenHands `buildStartConversationRequest` 的请求建模。

**要改的 Go AI 文件**：
- 新增 `lib/taskRouter.ts`：`classifyTask(prompt, attachments, model, settings): TaskIntent`；内置启发式（显式文件类型词 / 附件+修改意图 / 回退 chat）；预留 `classifyWithModel()` 钩子。
- 改 `lib/toolRegistry.ts`：`isFileTaskPrompt` 保留为 Router 的输入，不再由前端直接调用。
- 改 `app/page.tsx:516`：`send()` 内 `isFileTaskPrompt(...)` 分支改为调用 `classifyTask` 的返回值分派（本 Phase 只分派到现有 chat / fileAgent，artifact 分支先落 `agent_workspace` 兼容）。
- 新增 `app/api/tasks/route.ts`（POST 统一任务入口；本 Phase 先返回 `{type}` 分类结果，供前端/测试用）。
- 新增 `tests/taskRouter.test.ts`：覆盖「做两页 PPT→artifact」「修改这个 html→agent_workspace」「纯问答→chat」「图片+改颜色→agent_workspace」「无附件闲聊→chat」。

**验收标准**：单测全绿；现有 chat / 文件 agent 两条路径在 E2E 下行为不变；`npm run typecheck && npm test` 通过。
**不做什么**：不实现 artifact 生成；不实现 agent 状态机；不改 provider 流式。

---

## Phase B：Artifact Service 独立化

**目标**：把 artifact 从「两个路由 + 磁盘 manifest」升级为服务端一等对象：store + registry + 短期签名下载 URL + job/message 绑定 + 过期回收接口。

**为什么先做**：聊天链路已有 artifact part（`lib/message/types.ts`），且文件生成链路（Phase E）和 agent 链路（Phase D/F）的产物都要落这里；先做它能立刻简化现有 `artifacts/create`，并给后面所有「产出文件」的能力一个统一出口。

**涉及模块**：Artifact Service（#6）、Persistence（#10 的 ArtifactStore 层）。

**参考设计**：LibreChat `/code/download/:session_id/:fileId` + JWT 短时效 URL + `pending→ready` 延迟预览（`api/server/services/Files/Code/process.js`）；E2B `downloadUrl(path)` 签名（`sandbox/index.ts:799`）。

**要改的 Go AI 文件**：
- 新增 `lib/artifacts/types.ts`（`Artifact` 类型：id/name/mime/size/kind/jobId/messageId/conversationId/createdAt/expiresAt/preview）。
- 新增 `lib/artifacts/store.ts`（文件落盘 + 元数据注册，接口化：本地实现 → 后续对象存储适配器）。
- 新增 `lib/artifacts/sign.ts`（下载 URL 短期签名，HMAC + 过期）。
- 改 `app/api/artifacts/create/route.ts`：写走 `store.create`，返回 `downloadUrl` 带签名。
- 改 `app/api/artifacts/[id]/route.ts`：校验签名 + 过期；支持 `?preview=1` 返回预览元数据（HTML 直读 / office `pending`）。
- 新增 `tests/artifacts.test.ts`：签名过期拒访问、路径穿越防护、job 绑定。
- 客户端 `components/message/MessageParts` 的 artifact part：接 preview 状态（`pending→ready`）。

**验收标准**：create/download 带签名与过期；job 绑定字段生效；预览状态机工作；单测通过。
**不做什么**：不做生成器（Phase E）；不做对象存储真正切换（留接口）。

---

## Phase C：Workspace Manager + File Processor

**目标**：引入会话级 workspace 抽象（Daytona session-reuse 模型），统一三类工作区（temporary/persistent/file-agent）；文件上传升级为「解析 → 入 workspace + 登记 manifest」，补上 ZIP zip-slip 防护与 symlink 限制。

**为什么先做**：workspace 是 agent 链路的承载体；当前 `files/upload` 与 `agent/task` 各自 mkdir，必须先统一，Phase D/F 才有稳定的落盘层。ZIP 安全是「文件进沙箱」的必要前提（**zip slip 是当前真实安全缺口**）。

**涉及模块**：Workspace Manager（#2）、File Processor（#8）、Persistence（WorkspaceStore 层）。

**参考设计**：Daytona sandbox 状态机 + autoStop/autoArchive（`apps/api/src/sandbox/services/sandbox.service.ts`）；microsandbox `openat2 RESOLVE_BENEATH` 防穿越；LibreChat 文件名 sanitize。

**要改的 Go AI 文件**：
- 新增 `lib/workspace/types.ts`（三类 workspace + `.go-ai/manifest.json` 结构）。
- 新增 `lib/workspace/manager.ts`：`createWorkspace(convId)` / `materializeWorkspace` / `storeVisionContext` / `collectOutputs` / `archiveWorkspace` / `cleanup(ttl)`。
- 新增 `lib/workspace/store.ts`（路径安全：任何 join 必须前缀校验 + 相对路径规整）。
- 新增 `lib/files/zip.ts`：安全解压（条目路径 must 落在目标目录、大小/数量上限、拒绝或剥离 symlink 条目）。
- 新增 `lib/files/processor.ts`：文本/CSV/JSON/HTML 项目识别 + 登记 manifest。
- 改 `app/api/files/upload/route.ts`：改走 `workspace.manager` + `files.processor`；ZIP 走安全解压。
- 改 `app/api/agent/task/route.ts`：workspace 创建/扫描逻辑收归 manager（本 Phase 行为保持）。
- 新增 `tests/workspace.test.ts` + `tests/zip.test.ts`：zip-slip 攻击样本、路径穿越、symlink 剥离、TTL 清理。

**验收标准**：三类 workspace 生命周期可测；ZIP 解压样本（含 `../` 穿越与 symlink）被拒绝/剥离；现有上传行为兼容；单测通过。
**不做什么**：不启动沙箱；不做 workspace 可视化；不迁移历史数据。

---

## Phase D：Agent Runner + Sandbox Runtime Adapter + Job Event Stream

**目标**：把「调用 agent 执行」从 `agent/task` 路由抽成三层——`AgentRunner`（任务编排/超时/重试）→ `SandboxRuntimeAdapter`（统一执行接口，首版包住现有 go-ai-file-agent）→ `JobEventStream`（服务端状态机，输出收敛的 NDJSON 事件）。为 Phase F/G 打底。

**为什么先做**：当前 agent 逻辑内嵌路由、状态由前端拼凑；不抽出来，Phase F（vision+文件进 agent）和 Phase G（Job UI）都无处挂载。这是「把 Claude Code 从路由里解放」的关键。

**涉及模块**：Agent Runner（#4）、Sandbox Runtime（#3）、Job Event Stream（#5）。

**参考设计**：E2B 两层结构（控制面 API + 沙箱内 agent，`NewSandbox→{sandboxID, envdAccessToken}`、`POST /run`、`GET/POST /files?path=`）；Modal 无头 `claude -p` + pty + workdir + 温沙箱池（`13_sandboxes/sandbox_agent.py`、`sandbox_pool.py`）；microsandbox `exec(cmd, args[])` + timeout/rlimit。

**要改的 Go AI 文件**：
- 新增 `lib/sandbox/adapter.ts`：`SandboxRuntimeAdapter` 接口（create/run/writeFile/readFile/download/destroy）。
- 新增 `lib/sandbox/dockerClaudeCode.ts`：首版实现，封装 go-ai-file-agent 契约；`run` 一律 `args[]` + timeout；DeepSeek V4 Flash 经 env/secret 注入。
- 新增 `lib/agent/runner.ts`：`runJob(task)` 建 job、写 `.go-ai/task.md`、spawn/watch/finalize；超时/失败产出 partial 结果。
- 新增 `lib/agent/jobStore.ts`：job 持久化实体（状态机字段 + 事件追加）。
- 新增 `lib/job/events.ts`：`JobStatus`（queued→creating_workspace→uploading_files→analyzing_image→reading_files→planning→editing→running_check→generating_artifact→done/failed）+ `JobEvent` union + NDJSON 序列化。
- 改 `app/api/agent/task/route.ts`：改为「Router→Runner→Adapter→JobEventStream」编排；保留 NDJSON wire 格式但事件类型收敛；vision 扫描逻辑移走（Phase F 收归 vision 模块）。
- 改前端 `app/page.tsx` 的 `runFileTask`：改用收敛后的 JobEvent union 渲染（可先最小：status 行 + artifact 卡）。
- 新增 `tests/agent/runner.test.ts` + `tests/job/events.test.ts`（状态机转换、超时、失败、事件序列化）。

**验收标准**：同一 prompt 经新编排产出与旧路径一致的最终文件；超时任务标记 `failed` 并保留 partial artifact；NDJSON 事件类型收敛为 union；单测通过。
**不做什么**：不新起独立 Sandbox Service 进程（下一阶段 I 可选）；不改 DeepSeek 模型；不实现并发调度。

---

## Phase E：PPTX / HTML / CSV Artifact 生成任务

**目标**：实现「文件生成链路」的确定性生成器：`artifact` 任务直接产出 .pptx / HTML / CSV，走 Artifact Service 交付，**全程不依赖沙箱**。根治「复制到 PowerPoint」。

**为什么先做**：这是用户最想要的「文件交付」体验里成本最低、见效最快的部分；且它依赖的 Artifact Service（Phase B）与 Router（Phase A）已就绪。

**涉及模块**：Task Router（artifact 分支落地）、Artifact Service（生成物入库）、Chat Renderer（artifact 卡预览）。

**参考设计**：LobeChat artifact Portal（`src/features/Portal/Artifacts/Body/index.tsx`）按 type 分发渲染；LibreChat office `pending→ready` 预览；生成器用服务端 Node 库（pptxgenjs / 手写 HTML 模板 / CSV 序列化）。

**要改的 Go AI 文件**：
- 新增 `lib/generators/pptx.ts` / `lib/generators/html.ts` / `lib/generators/csv.ts`：输入任务说明（+可选数据/引用文件），输出 `Artifact`。
- 新增 `lib/generators/registry.ts`：`artifactKind → generator` 映射。
- 新增 `app/api/tasks/route.ts` 的 artifact 分支（Phase A 只返回分类，这里真正执行生成）。
- 改前端：`MessageParts` 的 artifact part 支持 pptx/html/csv 预览卡（HTML 内联 iframe / 文件下载卡 / office pending 状态）。
- 新增 `tests/generators/*.test.ts`：PP 生成、HTML 转义安全（防注入）、CSV 注入防护（`=`, `+`, `-`, `@` 前缀防公式注入）。

**验收标准**：输入「做两页 PPT」→ 产出可下载 .pptx 并显示卡片；HTML 生成不含未转义注入；CSV 无公式注入；**回复里不再出现「复制到 PowerPoint」**（生成器模式天然规避）。
**不做什么**：不做富文本编辑器；不做复杂排版模型。

---

## Phase F：Vision + Files → Agent Workspace（Agent 链路收口）

**目标**：让「图片 + 文件 → 云端 Agent」闭环：workspace 图片 → Vision Preprocessor 结构化上下文 → 连同文件/任务说明一起进 Agent Runner。形式化现有 vision 扫描，并补 File Processor 的 workspace 登记。

**为什么先做**：这是用户目标的完整闭环（图片理解 + 文件系统 + 云端沙箱）；依赖 C（workspace）与 D（runner/adapter）已完成。

**涉及模块**：Vision Preprocessor（#7 形式化）、Workspace Manager（materialize 收口）、Agent Runner（上下文注入）。

**参考设计**：沿用本项目 `lib/vision.ts` 的 UNTRUSTED 模型（已是参照级）；OpenHands 的「图片与文本同帧」发送。

**要改的 Go AI 文件**：
- 新增 `lib/vision/workspaceScanner.ts`：从 `agent/task` 路由抽出「扫描 workspace 图片 → MiniMax → 写 `.go-ai/vision/*.json`(结构化) + `*.md`(摘要)」。
- 改 `lib/vision.ts`：`describeImageBase64` 返回结构化字段（summary/visible_text/layout/ui_elements/important_details/uncertainty），保留文本块生成。
- 改 `lib/agent/runner.ts`：任务 spec 注入 vision 上下文路径 + 文件清单 + 任务说明；明确「视觉内容为 UNTRUSTED」。
- 改 `lib/files/processor.ts`：登记文件清单进 `.go-ai/manifest.json`，供 agent 读取。
- 新增 `tests/vision/workspaceScanner.test.ts`（mock MiniMax）。

**验收标准**：「上传截图 + 改这个页面」→ workspace 含 vision 结构化上下文 + 文件 → agent 修改 → 产物 artifact；vision 失败降级不阻塞任务。
**不做什么**：不做多轮视觉对话；不做扫描 PDF OCR。

---

## Phase G：前端 Job Event UI

**目标**：把 Job Event Stream 渲染成专业状态 UI：JobCard 状态机（queued→…→done/failed）、当前工具提示、进度、artifact 卡片组；不再用「正在处理文件…」单行字符串。

**为什么先做**：用户体验的最直接提升，且依赖 D（事件 union）与 B（artifact）已完成；此时才做 UI，避免用旧事件结构返工。

**涉及模块**：Chat Renderer（#9 扩展）、Artifact Service 前端消费。

**参考设计**：OpenHands `task-list-tab.tsx` + `use-task-list`（todo/in_progress/done）；LibreChat `Attachment.tsx` 卡片路由 + `pending→ready`；LobeChat thinking 折叠。

**要改的 Go AI 文件**：
- 新增 `components/job/JobCard.tsx`：状态机徽标 + 当前工具 + 进度条 + 错误信息。
- 新增 `components/artifact/ArtifactCard.tsx`：按 kind 路由预览（html 内联 / image / pptx/csv 下载卡 / pending 态）。
- 改 `components/message/MessageParts.tsx`：tool_status part 升级为 job part；artifact part 用新卡片。
- 改 `app/page.tsx`：`runFileTask` 改用 JobEvent 订阅渲染（替换 statusLine 字符串拼接）。
- 新增前端组件测试（可沿用现有 test setup）。

**验收标准**：agent 任务全程显示 8 段状态流转；失败显示明确错误 + 保留 partial artifact；移动端可用。
**不做什么**：不做终端日志展示（不把原始 log 给用户）；不做 WebSocket。

---

## Phase H：稳定化与真实回归

**目标**：全量回归：typecheck + 单测 + 生产构建 + E2E + 真实任务跑通（普通聊天 / PPT 生成 / 图片+文件 agent 三条链路）；性能与超时检查；边界巡检。

**为什么最后做**：所有模块已收敛，此时回归才有意义；也符合用户「交付前全量验证」的既定要求。

**涉及模块**：全部；重点回归 Task Router 判定、Artifact 签名/过期、ZIP 安全、Job 状态机、双 provider 聊天。

**要改的 Go AI 文件**：无新增；修正 Phase A–G 回归发现的问题。
**验收标准**：`npm run typecheck && npm test` 全绿；三条链路手工跑通；`npm audit --omit=dev` 高危为 0；部署后上线检查清单（登录/模型/聊天/vision/文件 agent/artifact 下载）全过。
**不做什么**：不引入新功能。

---

## 后续可选（本计划不含，记录备选）

- **Phase I：独立 Sandbox Service**（按 E2B API 形状自建，Docker 生命周期 + `POST /sandboxes`、`/files?path=`、`/run`、TTL；Vercel 前端只持会话 token）。当前 go-ai-file-agent 是它的首版形态，先被 Adapter 包住，后续可平滑替换。
- **Phase J：Snapshot 归档**（Daytona 模式：workspace→镜像/对象存储，跨会话恢复）。
- **Phase K：MCP 接入**（Tool Registry 增加 `server:mcp:` 前缀来源，参照 Open WebUI `MCPClient`）。
- **Phase L：多用户**（RUN_CODE 级权限门控、用户级 access_grants、服务端 conversation history）。

---

## 第一阶段建议

**Phase A（Task Router + Task Types）优先**。理由：
1. 零风险、纯判定、不触碰执行路径，立刻能验收；
2. 它是唯一「所有其他 Phase 都依赖」的地基（B/C/D/E/F/G 都要按 `task.type` 分派）；
3. 顺带把当前 `page.tsx` 里硬编码的 `isFileTaskPrompt` 分叉收敛，减少前端与判定逻辑的耦合；
4. 不依赖尚未就绪的模块，可在现有代码库直接落。

Phase A 完成后即按 B→C→D→E→F→G→H 顺序推进（每 Phase 独立验收，不影响现有 chat）。

---

## 附：为什么不是先继续修当前 bug

当前待修项（DeepSeek reasoning、PPTX、Memory/Skills/Settings、UI 美化）都属于**旧「聊天客户端」范式内的局部优化**：修好了，Go AI 仍是「聊天框 + API + 附件」，无法支撑「网页入口 + 云端沙箱智能体 + 文件系统 + 图片理解 + 文件生成/编辑 + Artifact 交付」的目标。研究结论（`RESEARCH_CLOUD_AGENT_PROJECTS.md`）表明：这类能力需要 Task Router / Workspace / Sandbox / Agent Runner / Artifact 这套结构，不是在某条聊天路由里打补丁。因此本轮先定架构与计划，再按计划推进；修 bug 的优先级低于让架构成型。
