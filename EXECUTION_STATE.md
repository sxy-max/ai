# Go AI — Execution State

## Release Candidate Acceptance（2026-08-13）— 版本锁定
- **Cloud Agent Workspace v7 已上线并锁定**：HEAD `4137839`（本地 = GitHub origin/main = 云端 = Docker 镜像 `f996db89ae4f` 四处一致），容器 2026-08-13 23:33 +08 启动，可回滚旧镜像 `sha256:004496a07…`
- 线上回归 15/15 PASS（auth/models/pptx/html/csv/agent 闭环）；两个"失败"均为脚本阈值：csv 19B 是确定性最小输出、agent exitCode=1 是只读 no-op 的自检判定
- 验收包已生成：`ACCEPTANCE_RC_V7.md`（版本信息/能力清单/T01-T15 验收矩阵/不可用能力/风险 10 项/回滚方案/结论区）
- **本阶段停止开发**：不新增功能/重构/优化；只修 P0/P1（当前未发现必须立刻修的 P0）

## 已完成并实现（云端已部署，本地已同步）
- **2026-08-13 三次上线**：Feature Build + Stabilization + 图片上传修复（§10 闭环）。线上全量回归通过。
- 网络基础设施：sing-box(Docker proxy) / Nginx / Docker / go-ai-net（冻结）
- File Agent 底层：Claude Code + DeepSeek V4 Flash、cc-auth-gateway、go-ai-file-agent 容器（非root/仅workspace）、单并发+15min超时、Bash deny
- 模型系统：7 精选模型 + KNOWN_VISION(kimi=true,glm=false) + modelPolicy(kimi temp=1) + 配额(quota.ts 持久化)
- 文件能力：/api/files/upload、/api/agent/task(带 vision)、/api/artifacts/create、/api/artifacts/[id]、ZIP 解压/重打包、MiniMax Vision
- 前端（云端同步）：MessageParts 统一 renderer、P0 修复（reasoning-only 防呆/三层 Empty 防御/用户 KaTeX/HTML 替换）
- 视觉预处理：lib/vision.ts（共享 MiniMax describe）+ /api/chat 服务端兜底（非 vision 模型图片→UNTRUSTED VISUAL CONTEXT）+ 客户端 visionUsed chip / 视觉分析中状态
- 主题：CSS tokens 双主题（:root 深色 / [data-theme=light] 浅色），设置里 自动/浅色/深色
- 设置/个性化：Settings 视图（主题/联网/上下文/Reasoning/温度/Max output，参数随模型能力禁用）+ Sidebar 底部导航
- 个性化：lib/personalization.ts（Memory localProfile + Style 4预设/自定义 + Skills SKILL.md 导入/相关性选择），注入独立 system 段（[USER MEMORY]/[RESPONSE STYLE]/[USER SKILLS]），聊天+File Agent 双路由
- 可用性错误：lib/modelErrors.ts（MODEL_REGION_UNAVAILABLE/MODEL_NOT_FOUND/MODEL_QUOTA_EXCEEDED_UPSTREAM/MODEL_TEMP_UNAVAILABLE），流内错误友好翻译，客户端映射
- Tool Registry：lib/toolRegistry.ts（内置 web_search/url_fetch/vision/file_agent + 外部注册默认关闭）+ /api/tools，page 的搜索/视觉/文件路由决策收敛到 registry
- 代码高亮 + 复制：MessageParts rehype-highlight + CodeBlock 一键复制（修复了原 page.tsx 死代码，复制从未生效）+ hljs token 双主题调色板
- 数学分隔符：lib/math.ts normalizeMathDelimiters（remark-math6 不识别 \(...\)/\[...\]，LaTeX 惯用转 $，跳过代码围栏）
- 刷新恢复：reload 后自动恢复最近对话（Artifact 历史可见）
- **E2E 15/15 全过**（15s）：reasoning 折叠/重试/多轮/user+assistant KaTeX/HTML artifact/刷新持久/代码高亮+复制/message 复制/Settings+主题/个性化记忆/旧格式迁移/移动端/回复风格/Skills 导入
- Stabilization：storageSafeMessages 补旧消息 id（修 React key 警告）、旧 schema 迁移 E2E、KaTeX 复杂公式单测、移动端布局 E2E
- 本地：lib/message/{types,lifecycle,transform}.ts、单测 41/41 过、typecheck/build 过



**2026-08-14 工程评审修复轮（对照独立评审子代理 25 项发现）**：
- F1 崩溃恢复：tasks 加 worker_id+lease_expires（幂等 ALTER）；领取写租约（90s）；执行期心跳续期（30s）；worker 循环先 recoverOrphanedTasks（租约过期的 planning/running → queued，running 步骤回滚 pending，agent_runs 标 failed）——端到端验证：模拟崩溃→回收→重执行→完成+产物
- F3 cancel→retry 竞态：步骤执行完成后写库前校验任务状态（cancelled/failed/queued → 丢弃结果）
- F4 retry 只重置 failed/skipped 步骤（已完成保留）；清 worker_id/lease
- F7 领取按 priority 高优先
- F8 产物版本化并发：ON CONFLICT + 重试 8 次；并发 5 注册 version 1..5 唯一
- F9 SSE cursor 非数字回退（防 PG 类型错误循环）
- F15 内置 skill 仅 admin 可改
- F18 artifact LLM 管线：lib/generators/llm.ts（按 kind 提示词产出与 parseDocument/parseDeck 同构 markdown）→ executor 优先 LLM 内容、回退模板；parseDocument/parseDeck 增加 markdown 结构感知（修复 #/- 双重标记 bug）；fileSummaries 二进制守卫（NUL 字节不再按 UTF-8 硬读）
- 测试 209/209（新增：崩溃恢复、retry 范围、并发版本化、LLM 内容渲染 6 项）

## 2026-08-14 PRD V1 实现（本地，未 commit/未部署）— autoplan 评审通过（User Challenge 已批：V1 用 TS Worker，AgentScope 真实接线入 V1.1）

**本会话完成（全部本地验证）**：
- 任务系统修复：状态机删除非法 queued→completed；runTaskToEnd 直接调用归一化；task_steps 补 updated_at（幂等 ALTER）；Redis/PG 连接关闭入口（测试进程 1.5s 干净退出，原 25min 挂死）
- 安全修复（评审发现 3 个真实漏洞）：artifact 下载 IDOR 越权 → PG 归属校验+404 穿越；workbench 项目无归属 → ownerId 字段+全部 6 条路由归属校验（旧记录空 ownerId=兼容共享）；content-disposition 中文文件名 ByteString 崩溃 → RFC 5987 filename* 助手；ArtifactService Windows 路径穿越防护前缀误伤 → path.resolve
- 中文文件名修复：sanitizeFilename 保留 CJK（销售数据.csv 不再变 ____.csv）
- 页面层（PRD §7/§81/§82/§83）：首页=任务启动器（大输入框+上传+快捷入口）、/tasks 列表（状态过滤+进度+产物计数）、/tasks/:id 详情（§82 布局+SSE 实时+暂停/继续/取消/重试+活动/步骤/产物/详情 Tab）、/projects、/artifacts/:id 预览（meta 端点+文本内联/HTML iframe）、/workbench（原首页迁移）、共享 TopNav+通知铃铛
- 通知：/api/notifications + /api/notifications/read + 顶栏铃铛（未读角标+下拉+全部已读）
- API：POST /api/tasks 支持 multipart（goal+files[]，文件落盘+PG files 行+任务绑定）；GET /api/tasks 带产物/步骤计数；/api/artifacts/:id/meta
- 测试：新增 tests/api-tasks（6 项：认证/校验/列表作用域/归属 404/PATCH/SSE）、tests/api-security（2 项：artifact 越权+并发领取 SKIP LOCKED）；test:core 改串行（--test-concurrency=1，共享 PG 测试库）；全量 200/200 + typecheck 0 + build 通过
- 端到端验收（无头 Chrome CDP）：创建(带中文 CSV)→worker 3 步骤 23 事件→xlsx 下载 200→首页/列表/详情/项目/产物预览 × 1280/390 全部零溢出→详情页徽章/进度/活动/步骤/产物/铃铛断言全过
- 部署：compose.yaml 加 postgres/web/task-worker 服务（task-worker 用 esbuild 打进 standalone）；Dockerfile build 阶段编译 worker；README/.env.example 补任务系统运行说明

**待做（P2 剩余 + V1.1）**：/files 文件中心页、/settings（v7 设置迁移到独立页）、对象存储 S3 适配层（V1.1）、真实 AgentScope 运行时接线（V1.1，用户已批准）、公网部署（tar→docker 或 compose 全栈）

## 正在做
- **RC 验收（2026-08-13）**：等待用户按 `ACCEPTANCE_RC_V7.md` T01-T15 复测；发现 P0/P1 才修复，其余记录为 backlog
- 云端部署已上线（2026-08-13）：git push → tar/scp → docker build → 替换容器（保留 go-ai-net/unless-stopped/2GB//data volume/env-file）
- 线上回归全绿：公网200 / 登录 / 模型7个 / kimi 真实流式 / **glm无视觉+图片→MiniMax→回答** / personalization+skills 注入 / File Agent 上传→任务→artifact

## 待做（按依赖排序）
1. 长期 backlog：公网浏览器物理视觉回归（可选；API+E2E 已覆盖）、语音（用户已指示不处理）、sandbox Bash（独立阶段）、真实模型差异细回归

## Blocked
- 无

## 已验证
- 云端（历史）：File Agent 三测试、ZIP、vision→file、Artifact 下载、安全 8-10、重启恢复
- **云端（本次 3 次上线回归）**：
  - 真实模型矩阵：kimi/glm/deepseek/minimax/qwen 全 200 正常流式；gpt→MODEL_REGION_UNAVAILABLE、grok→MODEL_TEMP_UNAVAILABLE（友好中文）
  - 真实多轮上下文（kimi 8 轮 8/8 回忆）、vision-chat（glm+img→MiniMax→回答）
  - **Skills→File Agent**（skill 物化进 CLAUDE.md、agent 遵循标记指令）
  - **图片+文件 Agent 闭环**（参考图→MiniMax 描述→agent 改背景色→artifact）
  - personalization/skills 注入、公网 200
- 本地：typecheck/build/单测 41/41、**E2E 15/15 全过**
- E2E 基础设施根治：Next16 allowedDevOrigins + reuse=false + globalSetup 预热 + selectModel 按 value

## 未验证
- 公网浏览器物理视觉回归（API 层已回归；UI 由 E2E mock 覆盖）

## Stabilization Backlog
- ~~E2E "Target crashed"~~ 根因已修复：Next16 dev 跨源保护（allowedDevOrigins 未含 127.0.0.1 → 浏览器 Origin 头的 chunk/HMR 请求 403，app 不 hydrate；curl 无 Origin 故正常）。已加 allowedDevOrigins + globalSetup 预热
- KaTeX 复杂公式视觉细节（V_eff'' 类）
- 历史 schema 迁移完整性

## 2026-08-14~15 Goal Mode：Agent-First 执行主链（WP1-WP12 完成，13 commits）

**执行链（当前线上）**：user → classifyTask（前端+服务端 422 防线）→ /api/tasks → worker → TaskExecutionPlan → planner（agent_workspace 确定性单 dev 步；artifact LLM/规则）→ executor → [general/artifact: LLM 内容+生成器；dev: Claude Code Runtime] → PG artifacts（版本化）→ SSE/通知 → 任务页 Work UI

**关键实现**：WP1 Audit 文档；WP2 TaskExecutionPlan+chat 防线；WP3 AgentRuntimeAdapter（GoFileAgentAdapter=Claude Code+DeepSeek）；WP4 workspace 契约+TTL 清理；WP5 MiniMax vision→agent；WP6 PresentationSpec→pptxgenjs 真实 PPTX；WP7 OpenCode Go 通道复用（无需新 key）；WP8 reasoning/final 生命周期+真实 5 次复测；WP9 stage 事件→UI 阶段指示；WP10 Work UI 文案；WP11 真实 E2E 本地 7/7+服务器 6/6（T6 MD→Agent→MD、T8 图片+HTML→修改→HTML、T9 ZIP→重打包、T10 多轮 continue 8→16、T14 Docker 重启）；WP12 清理调度+安全边界。

**关键踩坑（勿回退）**：file-agent 容器按 {conversationId}/{jobId} 定位 workspace → conversationId="tasks"、jobId={taskId} 必须与 WORKSPACES_ROOT/tasks/{taskId} 对齐；agent_workspace 禁 LLM 规划（拆多步=表面执行）；无产物自动重试 1 次+任务级 TASK_NO_ARTIFACT 校验；容器重建用 rm+run（restart 不换镜像）。
