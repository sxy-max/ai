# Phase A Task Router Design

> 日期：2026-08-13 ｜ 依据：`GO_AI_CLOUD_AGENT_ARCHITECTURE.md`（模块 #1 Task Router）、`IMPLEMENTATION_PLAN_CLOUD_AGENT.md`（Phase A）、`RESEARCH_CLOUD_AGENT_PROJECTS.md`
> 范围：**只做分类与分派地基**。不写生成器、不写沙箱编排、不改 chat 执行路径。本文件是设计，不含业务实现。
> 原则：**保守路由**——只有高置信信号才离开 chat；拿不准一律回退 chat。任何情况下新 Router 不得把旧 `isFileTaskPrompt` 判定为文件任务的消息判成纯 chat（防回归）。

---

## 1. 当前问题

任务类型判定当前**分散在前端与后置正则**，没有单一决策源：

| 位置 | 现状 | 问题 |
|---|---|---|
| `app/page.tsx:516` | `send()` 内 `if (isFileTaskPrompt(input, attachments.length>0)) → runFileTask`，否则走普通 chat | 唯一的「大分叉」是前端硬编码；只有 Chat / FileAgent **二分**，没有 `artifact` 概念 |
| `lib/toolRegistry.ts:38` | `isFileTaskPrompt(p, hasFiles)`：词表 + 「hasFiles 且含修改动词」正则 | 是判定实现，但被前端直接调用，且只回答「是否文件任务」 |
| `lib/toolRegistry.ts:87` | `file_agent` 工具的 `trigger` 复用 `isFileTaskPrompt` | 语义耦合：工具触发 与 请求分派 共用同一个布尔 |
| `app/page.tsx:382` | `processAutoArtifact`：**事后正则** `/(给我.*文件|发.*文件|生成.*(html|index)|html 文件|文件给我|给我下载)/`，等模型答完再从回复里抽 HTML 造 artifact | 「生成文件」意图没有在入口被识别，靠事后捞取，不稳定、漏判多 |
| `app/api/chat/route.ts` | 纯聊天流，无路由 | 职责正确（chat 只做 chat） |
| `app/api/agent/task/route.ts` | 代理 go-ai-file-agent，自己 mkdir workspace / 扫图 / 拷 artifact | 无判定（前端决定来不来调用），路由与执行耦合 |
| `app/api/files/upload/route.ts` | 上传进 workspace，无判定 | 同上 |
| `app/api/artifacts/create/route.ts` | 磁盘 manifest 写入，无判定 | 同上 |

**结论**：现有「分派」完全在 `page.tsx` 一行 if 上；`processAutoArtifact` 是补丁式的「事后造 artifact」。Phase A 要做的：把入口判定收敛为一个服务端可测、可返回结构化结果的 `classifyTask`，先保留现有两条执行路径（chat / file_agent），把 `artifact` 类型立起来，留好 Phase E 的挂载点。

---

## 2. Phase A 目标

1. 建立 `TaskType = "chat" | "artifact" | "agent_workspace"` 的单一分类源，前端只消费结果，不再自己拼判定。
2. 分类逻辑进 `lib/taskRouter.ts`（纯函数、无 I/O、可单测），并暴露 `POST /api/tasks/classify` 供前端与测试用。
3. **不破坏任何现有能力**：普通聊天、文件上传、File Agent、Artifact 下载、图片上传、模型选择、localStorage 历史。
4. 保留 `isFileTaskPrompt` 作为底层信号 + 回退兜底；新 Router 是其**超集**，保证不回归。
5. `artifact` 分支在 Phase A 先**别名到现有 file_agent 分派**（行为与今天一致：由 Claude Code 产出真实文件），Phase E 再替换为生成器。
6. 为 Phase B（Artifact Service）/ C（Workspace）/ D（Runner+Adapter）铺平统一的 `task.type` 入口。

---

## 3. Task Types

```ts
export type TaskType = "chat" | "artifact" | "agent_workspace";

export type ArtifactKind =
  | "pptx" | "html" | "csv" | "markdown" | "json"
  | "zip" | "image" | "unknown";

export type TaskConfidence = "high" | "low";

export type RouteTarget = "chat" | "file_agent" | "artifact_generator";

export type TaskIntent = {
  type: TaskType;
  artifactKind: ArtifactKind | null;      // 仅 type==="artifact" 时使用
  needsSandbox: boolean;                  // agent_workspace=true
  confidence: TaskConfidence;
  reason: string;                         // 命中的规则名，便于调试/测试
  routeTarget: RouteTarget;               // Phase A 实际分派目标（见 §6）
};
```

要点：
- `routeTarget` 与 `type` 解耦。`type` 是长期稳定的分类语义；`routeTarget` 是**当前阶段**的分派目标（Phase A 里 `artifact` 的 routeTarget 是 `artifact_generator`，但分派时别名到 file_agent，见 §6）。
- `reason` 必须可断言，供单测锁定规则。

---

## 4. Router 输入输出

### 4.1 输入

```ts
export type ClassifyInput = {
  prompt: string;
  attachments: Array<{ kind: "text" | "image"; mime: string; name: string }>;
  model?: { key: string; vision: boolean | "unknown" };
  settings?: { searchMode?: "off" | "auto" | "on" };
  conversation?: { activeFileTask?: boolean };  // 是否处于文件/Agent 任务的延续轮
};
```

映射到现有前端状态：
- `prompt` ← `input.trim()`
- `attachments` ← `attachments`（含 kind、mime、name）
- `model` ← `selectedModel`（vision 能力）
- `settings` ← `searchMode`（本轮仅记录，不参与判定）
- `conversation.activeFileTask` ← 最近一条 assistant 消息是否来自 `runFileTask`（Phase A 可选；用于「改颜色」这类无附件续轮）

### 4.2 输出

返回 `TaskIntent`（见 §3）。语义约定：
- `type="chat"` → 走现有普通聊天（含图片问答、vision 预处理、web 搜索、skills）。
- `type="artifact"` → 未来走生成器；Phase A 别名到 file_agent 分派（行为同今天）。
- `type="agent_workspace"` → 走 `runFileTask`（现有 file-agent 链路），未来接 Workspace Manager + Agent Runner。

---

## 5. 第一版分类规则

按优先级从高到低执行，**全部不命中则回退 `chat`**。`hasFiles` = 附件中存在 `kind==="text"` 的文件；`hasImages` = 附件存在图片。

### R0 无效输入 → 拒绝
- `prompt` 为空 且 无任何附件 → 返回 `null`（调用方不发送）。
- （现状 `page.tsx:511` 已拦截，Router 内也兜底。）

### R1 显式文件生成 → artifact（high）
- 动词（做/生成/创建/给我/发/导出/做一份/写一个/做一个）+ 文件类型名词（PPT/PPTX/幻灯片/HTML/网页/表格/CSV/Markdown/MD/JSON/ZIP/PDF/文档/文件）。
- 或语气：`不要贴代码，直接给文件`、`给我下载`、`发文件给我`。
- 输出 `artifactKind`：名词映射 `pptx / html / csv / markdown / json / zip / image / unknown`。
- 例：`做两页 PPT` → artifact/pptx；`生成 HTML 文件` → artifact/html；`导出 CSV` → artifact/csv；`给我一个 markdown 文件` → artifact/markdown。

### R2 文件 + 修改/处理意图 → agent_workspace（high）
- `hasFiles === true` 且 prompt 含修改类动词（修改/编辑/改/处理/修复/整理/重构/优化/把……改/按/根据/修复/适配）。
- 例：`修改这个 HTML`、`整理这个 Markdown`、`把这个 ZIP 项目改一下`。
- 区分：**带文件但只是问内容**（总结/讲了什么/解释/介绍/翻译/读取/看看/帮我读）→ 走 chat（复用现有附件进上下文的机制），不进 agent。

### R3 图片 + 修改/复刻/分析并改动 → agent_workspace（high）
- `hasImages === true` 且 prompt 含「按图/根据图 + 修改类动词」（按照截图/根据截图/按这张图/照着 + 修改/改/复刻/修复/实现/调整）。
- 例：`按照这张截图修改网页`、`根据这张图做 PPT`、`分析这张错误截图并修改项目`。
- 判断依据：意图是「根据视觉内容改动产物」，不是「看图答问题」。

### R4 图片 + 纯问答 → chat（high）
- `hasImages === true` 且意图是「描述/解释/问内容」：你看到了什么/里面写了什么/这张图讲什么/描述一下/这是什么。
- 走现有 chat + 服务端 `preprocessVision`（非 vision 模型自动 MiniMax 预处理），**不进 agent**。

### R5 纯文本构建项目 → agent_workspace（low，需会话上下文）
- 无附件，但语义是多文件项目/可运行工程：`构建/写一个/开发一个/做一个 + 项目/网页项目/App/脚本/仓库`。
- 例：`构建一个小网页项目` → agent_workspace(low)。
- 单文件简单输出（`生成一个简单的 html`）→ 归 R1 artifact。

### R6 纯文本无附件闲聊 → chat（high）
- 其余全部 → chat。例：`解释一下什么是商业`、`你好`。

### 5.1 与旧 `isFileTaskPrompt` 的兼容约束
`isFileTaskPrompt(p, hasFiles) === true` 但上面规则判为 `chat` 时，**不得降级为 chat**——统一按 `agent_workspace(low)` 处理（保持今天「会被文件 agent 处理」的行为）。规则按表覆盖后仍落 chat 的，再叠加此约束。这样新 Router 是旧判定的**超集**，杜绝回归。

### 5.2 已知边界（Phase A 接受）
- `改背景/改颜色/改成浅色` 等无附件纯色改 → 只有 `conversation.activeFileTask` 为真才进 agent_workspace；否则 chat。可在 Phase G 加 UI 手动切换兜底。
- `分析这个错误日志`（文件）→ 归 R2 agent_workspace；`分析这份文档讲了什么`（文件）→ 走 chat。两者靠「是否含修改/处理类动词」区分，低置信场景宁可 chat。

---

## 6. 与现有代码的接入点

```
app/page.tsx:516  send()  ──►  classifyTask(input)  ──►  TaskIntent
                                    │
        routeTarget === "chat"      │ routeTarget === "file_agent" / "artifact_generator"(Phase A 别名 file_agent)
              │                     │
              ▼                     ▼
   现有普通聊天块（512-648）      runFileTask(...)（403-457，现有 file-agent 链路）
```

- `page.tsx` 只做**一次** `classifyTask`，按 `routeTarget` 分派；不再直接 import/调用 `isFileTaskPrompt`。
- `isFileTaskPrompt` 留在 `lib/toolRegistry.ts`，继续服务 `file_agent` 工具的 `trigger`（§1 表内行为不变），并作为 §5.1 的回退约束输入给 Router。
- `app/api/chat`、`app/api/agent/task`、`app/api/files/upload`、`app/api/artifacts/create` 的**执行逻辑本轮不动**。
- `processAutoArtifact`（`page.tsx:382`）本轮**保留**（它是现有 chat 链路的事后 artifact 兜底），Phase E 由真正的 artifact 分派逐步取代。

---

## 7. 文件修改计划

| 动作 | 文件 | 内容 |
|---|---|---|
| 新增 | `lib/taskRouter.ts` | `TaskType/ArtifactKind/TaskConfidence/RouteTarget/TaskIntent/ClassifyInput` 类型 + `classifyTask(input): TaskIntent | null`（纯函数，R0–R6 规则）+ 内部规则名常量 |
| 新增 | `app/api/tasks/route.ts` | `POST /api/tasks/classify`：校验 → 调 `classifyTask` → 返回 `{type, artifactKind, needsSandbox, confidence, reason, routeTarget}`；鉴权沿用 `lib/auth` 的 `isAuthorized`；无执行 |
| 修改 | `app/page.tsx` | `send()`：`const intent = classifyTask({prompt, attachments, model, settings, conversation})`；`routeTarget==="chat"` 走原 chat 块，否则走 `runFileTask`；删除对 `isFileTaskPrompt` 的直接调用（约 1–3 行变化，其余不动） |
| 不动 | `lib/toolRegistry.ts` | 保留 `isFileTaskPrompt` / `resolveTaskTools`（仍被工具触发与 §5.1 使用） |
| 新增 | `tests/taskRouter.test.ts` | 见 §8 |

> 变更面极小：核心是「新增 2 个文件 + 改 `page.tsx` 1 处分支」。回滚即恢复 `page.tsx` 那 3 行。

---

## 8. 测试计划（`tests/taskRouter.test.ts`）

沿用现有测试风格（`tsx --test` + `node:assert/strict`，参考 `tests/toolRegistry.test.ts`）。

### 8.1 分类正确性
| 输入（prompt, 附件） | 期望 |
|---|---|
| `做两页 PPT`（无附件） | artifact / pptx / high / routeTarget artifact_generator |
| `生成 HTML 文件`（无附件） | artifact / html / high |
| `导出 CSV`（无附件） | artifact / csv / high |
| `给我一个 markdown 文件`（无附件） | artifact / markdown / high |
| `不要贴代码，直接给文件`（无附件） | artifact / unknown / high |
| `修改这个 HTML`（1 个 text 附件） | agent_workspace / needsSandbox=true |
| `整理这个 Markdown`（1 个 text 附件） | agent_workspace |
| `把这个 ZIP 项目改一下`（1 个 zip 附件） | agent_workspace |
| `按照这张截图修改网页`（1 个 image 附件） | agent_workspace |
| `根据这张图做 PPT`（1 个 image 附件） | agent_workspace |
| `分析这张错误截图并修改项目`（1 个 image 附件） | agent_workspace |
| `你看到了什么`（1 个 image 附件） | chat |
| `这张图里写了什么`（1 个 image 附件） | chat |
| `这个文件讲了什么`（1 个 text 附件） | chat（文件 QA，不走 agent） |
| `解释一下什么是商业`（无附件） | chat |
| `你好`（无附件） | chat |
| `构建一个小网页项目`（无附件） | agent_workspace / low |
| `生成一个简单的 html`（无附件） | artifact / html |
| ``（空，无附件） | null（拒绝） |

### 8.2 兼容约束
- 对一组「旧 `isFileTaskPrompt=true`」用例：新 Router 不得返回 `type="chat"`（超集保证）。
- `isFileTaskPrompt` 用例（`处理一下` 有/无文件）行为与现在一致。

### 8.3 回归
- 现有 `tests/toolRegistry.test.ts` 全绿（`isFileTaskPrompt`/`resolveTaskTools` 未变）。
- `npm run typecheck && npm test` 全绿。
- E2E：普通聊天 / 文件 agent 两条链路行为不变（由用户确认方向后执行）。

---

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 破坏普通聊天 | `chat` 路径代码零改动；`classifyTask` 为纯函数，chat 判定保守（R1–R3 高置信才离开 chat） |
| 误判成 chat 导致文件任务丢失 | §5.1 超集约束：旧 `isFileTaskPrompt=true` 永不降级 chat；`reason` 字段便于定位误判规则 |
| Router 误判 | 提供 `POST /api/tasks/classify` 手工探测；Phase G 补 UI 手动切换（「转普通聊天 / 转文件处理」）；本轮先保留现状分派，不引入新行为 |
| artifact 分支无执行体 | Phase A 别名到 file_agent（与今天行为一致：Claude Code 产出真实文件），Phase E 才替换为生成器 |
| 回滚 | 核心改动收敛在 `page.tsx` 一处分支（约 3 行）：恢复 `if (isFileTaskPrompt(...))` 即完全回到旧逻辑；新增文件可留可删 |
| 可选开关 | 支持 `TASK_ROUTER_DISABLED=1` 时 `page.tsx` 直接走旧逻辑（默认不启用） |

---

## 10. Phase A 完成标准

1. `classifyTask` 在 `tests/taskRouter.test.ts` 全部用例通过（§8）。
2. `npm run typecheck && npm test` 全绿（含既有 `toolRegistry`/`message-lifecycle` 等回归）。
3. `POST /api/tasks/classify` 对 §8 样本返回稳定且字段完整。
4. `page.tsx` 只按 `classifyTask` 的 `routeTarget` 分派；不再直接调用 `isFileTaskPrompt`。
5. 手工回归：普通问答、图片问答、文件上传、文件修改、Artifact 下载、模型选择、localStorage 历史——行为与提交前一致。
6. `artifact` 类型已立起，`reason` 可追踪，Phase E 挂载点就位（`routeTarget="artifact_generator"` 一处即可切换）。
7. 未引入任何执行侧改动（生成器 / 沙箱 / Workspace / Agent Runner 均未实现）。
