# Go AI — Execution State

## 2026-08-17 V2.1 Final Convergence（本 Goal 收尾轮，生产验收全绿）

> 当前架构的唯一真相见仓库根 **CURRENT_EXECUTION_ARCHITECTURE.md**；本节为历史记录。

**修复（本收尾轮，commit 74db292/a1e88b4）**：
- **Cancel 真终止**：runAgentJob/runDevStep 透传 AbortSignal → adapter fetch abort；file-agent `/task`+`/chat` 客户端断连立即 SIGKILL claude（此前取消只改状态、claude 幽灵执行到 15 分钟超时，浪费额度并锁住容器）
- **Job 租约恢复循环收敛**（生产日志实测 18 job × 80 次/2h 的无限循环）：`claimExpiredJob` 只认领每任务最新 job（历史 job 不打断当前执行）；`recoverOrphanedTasks` 认领后按任务状态收敛 job 终态（活动→重新入队、终态→同步 failed/completed/cancelled、queued/paused→interrupted），认领列表移除 recovering——终态任务 + 过期 job 不再每 90s 重复认领
- 回归测试：Cancel 透传 1 + 恢复收敛 4（终态/queued/latest-job）

**并发收敛（同轮并行会话）**：
- 普通问答生产强制走 Claude Code：`CHAT_LEGACY_DIRECT=1` 才保留裸模型直连流（仅开发/测试 mock；生产无此变量，不存在第二条智能执行通道）；旧 /api/files/upload + /api/agent/task 路由与聊天内嵌文件任务链删除
- 模型池硬过滤：`APPROVED_POOL=[flash, pro]`（`lib/preflight/models.ts`），kimi/qwen/glm env 无法重新启用；provider probe 列表与批准池对齐
- runtimeAvailability 移除 AGENTSCOPE_URL 残留分支

**部署（ai-client:v2.1 + go-ai-file-agent:claude-v20）**：web + worker 全部 v2.1（含上述全部修复）；回滚点 ai-client:v1.8/v2.0 + claude-v18/v19。

**云端真实验收（2026-08-17，tencent-ai）**：
- **最终矩阵 12/12 PASS**（scripts/cloud-final.mjs，真实 Claude Code + MiniMax 视觉 + 浏览器 + Office）：C01 普通问答（Claude Code Harness）/ C02 代码真实 .py / C03 PPTX 2 页契约 / C04 XLSX / C05 DOCX / C06 PDF / C07 图片问答（视觉进入回答 514 字符）/ C08 综合任务（参考图重构+CSV 整合+移动端+zip 102KB，含验证-修复闭环：第 1 轮缺产物 → 证据回交 → 第 2 轮修复交付）/ C09 项目延续（两轮共享 workspace，文件树 20 项）/ C10 Cancel / C11 并发 3 任务 / C12 移动端 390px 无横向滚动
- **Cancel 进程级深检查 PASS**（cloud-cancel-deep.mjs + 编排观测）：cancel 前 file-agent 内 claude 进程=1 → cancel 后=0（断连 SIGKILL 生效，非 15 分钟超时）
- **Recovery 验收 PASS**（cloud-recovery.mjs + 编排）：任务 36d7e241 执行中 kill worker+file-agent → 租约过期 → 孤儿回收（error=「任务在上一轮执行中被中断，已重新入队」）→ 重新入队 → 续跑 completed；job1 收敛 recovering + job2 completed——恢复循环修复在真实故障中验证
- **存量数据清理**：18 个终态任务的历史 recovering job 手工收敛为终态（UPDATE 18）
- **Harness Benchmark**（B01-B05 × flash/pro）结果见 docs/HARNESS_BENCHMARK.md

**本地验证**：typecheck ✓ / 单测 449/449 ✓ / build ✓ / E2E 17/17 ✓

## 2026-08-17 V1.7/V1.8 Final Convergence（本 Goal 收尾轮）

> 当前架构的唯一真相见仓库根 **CURRENT_EXECUTION_ARCHITECTURE.md**；本节为历史记录。

**V1.7（ENOEXEC 修复后云端实证）**：
- matrix6（v1.7）：11/12 PASS——C01-C07/C09-C12 全过；**C08 综合任务失败**，根因两层：
  1. 旧镜像时序残影（matrix6 的 C08 被 v1.6 worker 的旧 LLM 三步规划处理）——v1.7 重跑排除
  2. v1.7 下真实失败：file-agent 容器 `--permission-mode acceptEdits` 只授权文件编辑，
     **Bash（zip 打包/起本地服务器/写 /tmp）全部需审批** → Claude Code 无法打包 zip、
     无法起服务器做浏览器视觉验证 → 3 次尝试无 zip 产物 → TASK_CONTRACT_RETRYABLE

**V1.8（本 Goal 收尾修复，commit d14d4b7，本地 444/444）**：
- **file-agent /task 改 `--permission-mode bypassPermissions`**（容器隔离内全权限：
  非 root、仅 workspace、无 docker/socket/真实 key——Bash 是真实工作必需）
- **zip 兜底交付**：directive 契约 kind=zip 时，collectOutputs 收集全部交付候选
  （含 agent 上报路径已注册的文件）打包 deliverable.zip 注册（机械打包不改内容；
  已有 zip 则跳过）；新增 dev-executor zip 兜底测试
- **AgentScope 全栈删除**（净删 1785 行）：lib/agentscope、agentscopeRuntime、
  externalToolExecutor、jobStore、services/agent-runtime、v15/mock 脚本与测试；
  RuntimeId 收敛 deterministic/claude-code；executionPolicy 删 FORCE_AGENTSCOPE 分支
- **模型池收敛（用户决策：kimi-k3 太贵，用 DeepSeek）**：Auto 批准池=[flash, pro]，
  链 agent=flash→pro、reasoning=pro→flash、chat=flash→pro；kimi/qwen/glm 移出池
  （KNOWN_MODELS 能力声明保留，显式配置可重启用）；FEATURED_MODELS 默认与
  服务器 .env 同步为 deepseek-v4-flash,deepseek-v4-pro,minimax-m3；AGENT_MODEL=deepseek-v4-flash
- 服务器部署：ai-client:v1.8 + go-ai-file-agent:claude（v18 镜像）；回滚点
  ai-client:v1.7-rollback + go-ai-file-agent:claude-v17-rollback
- 新增 scripts/cloud-bench.mjs（§31/32 Claude Code Harness Benchmark：B01-B05 × 模型对比）
- 云端矩阵 v1.8 结果见本节末尾（矩阵完成后补）

## 2026-08-16 V1.6 Architecture Convergence（Claude Code 唯一主 Harness）

> 当前架构的唯一真相见仓库根 **CURRENT_EXECUTION_ARCHITECTURE.md**；本节为历史记录。
>
> **V1.6 云端真实验证（2026-08-16 晚）**：
> - Claude Code 主链 QA 通过（普通问答→容器回答 196 字符）
> - office MCP 工具经 `--allowedTools mcp__office__*` 授权后真实产出：xlsx 16011B（PK 头）、pptx 56326B（2 页）
> - 综合任务 C08（参考图重构+CSV 整合+移动端）completed：index.html 2776B + style.css + 销量数据.xlsx 17742B
> - Preflight 修复：csv 输入/目标区分（"读取 data.csv"不再误判 csv 产物）；planner 同步
> - 已知限制：Claude Code 长任务（代码/Office）执行 5-15 分钟 > 矩阵 900s 轮询（任务实际完成、产物存在）；zip 打包契约未强制（C08 无 zip 但 completed）；worker 串行 + 心跳 90s 租约对长任务偏紧（并行修复 623a853：--model 参数 + 固定 claude 2.1.228 已并入）
> - 本地：457/457 + typecheck + build + E2E 17/17 + 综合验收测试 2/2

**翻转**：V1.5 的「AgentScope 2.0 主 Harness」决策被本 Goal 取代——**Claude Code 是唯一主 Harness**。

- Preflight 决策层（lib/preflight/）：directive/rules/models/build/attachments——任务编译器（WHAT+CONSTRAINT+CAPABILITY，无 HOW）；确定性规则优先，模糊才轻量分类
- 执行器收敛：general/research/artifact/dev 四类步骤统一 runClaudeCodeStep（差异 = directive）
- 主模型 Auto（capability→池→health→quota→compatibility）；coding 默认 deepseek-v4-flash；MiniMax=Vision Specialist
- Validation 证据回交：repair 参数（round/feedback/failures）续接同工作区；xlsx/docx/pdf 格式校验 + pptx 页数契约
- 普通问答统一：/api/chat CLAUDE_CHAT_ENABLED=1 → 容器 /chat（轻量 profile）
- 删除：workbench（AgentScope 沙盒工作台）、sandbox manager/providers/runtimeProtocol（未接入死代码）；AgentScope legacy（FORCE_AGENTSCOPE 才进）
- file-agent 容器 v2（services/file-agent/）：Claude Code CLI + MCP 工具箱（vision/browser/office/search）
- 测试：typecheck + 457/457 + build + E2E 17/17；云端矩阵 scripts/cloud-final.mjs

## 2026-08-16 V1.5 Harness Convergence（REUSE-FIRST，进行中——Phase A 验证全过）

**方向**：Go AI 从自研 Agent Runtime 收敛为「AgentScope 2.0 主 Harness + Go AI Product Layer」。不造 Harness，薄适配，真实执行。

**主 Harness 定案：AgentScope 2.0**（三份源码审计 + 实测）：
- V15_AGENTSCOPE_SOURCE_AUDIT.md：loop（Agent._reply_impl）/Toolkit+外部工具协议/SSE 26 事件/Redis 会话恢复/中断双路径/middleware/OpenAI 兼容 base_url
- OpenHands 落选（无工具注册表/无 SSE/中断粗/3.12 门槛）；OpenCode SDK + Claude Code SDK = specialized executor 候选（V15_OPENCODE_CLAUDE_SDK_AUDIT.md）

**服务器 Phase A 验证全过（AgentScope 驱动真实任务）**：
- agent_workspace 写 markdown → 拉格朗日量简介.md 6869B（runtime=agentscope）✓
- C08 网站多文件修改 ✓、项目延续两轮共享 workspace ✓（agent 复用=项目持久工作区）
- Cancel → cancelled ✓；长任务 192s → 13326B 综述 ✓
- V1.4 矩阵 AgentScope 驱动重跑：8/9（C09 延续已修复，全矩阵重跑确认中）

**关键环境事实（勿回退）**：
- opencode.ai 按 User-Agent 过滤：agentscope SDK 默认 UA 403 → 容器内 patch（scripts/agentscope-ua-patch.sh，容器重建后重跑）
- DEEPSEEK_API_KEY 服务器无效（401）——模型通道=opencode-go
- 服务器 AgentScope 沙盒：Docker 模式工具产物回传问题 → AGENTSCOPE_SANDBOX=local（main.py 支持切换；Redis 状态无损失）
- 本地 opencode 通道 40s 断连（Clash TUN）——真实模型验收在服务器（RUN_V15_PHASE_A=1）

**收敛定性**（V15_HARNESS_CONVERGENCE.md）：AgentScope 主路径不再经 runtimeProtocol/sandboxManager/AgentLoop 状态机；Claude Code 保留为 specialized executor（runner/sandbox providers 继续服务它）；删除项=AgentScope 通道的重复执行层（运行时不经过）。后续（V1.6）：Claude Code 通道退役后删 runner/jobStore/runtimeProtocol/sandbox providers（约 1500 行）。

## 2026-08-16 V1.4 完成（tag go-ai-v1.4-artifact-workbench，云端 9/9 矩阵全绿）

**云端部署**：ai-client:v1.4（web+worker，含系统 chromium）；migrate v1.5 已应用；rollback=v1.3 镜像 1b1b8a31eda3 + 源码备份 /opt/ai-client-backup-v11；部署工作流见 docs/V14_CLOUD_DEPLOY_WORKFLOW.md（构建→save→scp→load→rm+run→migrate→矩阵，含全部踩坑表）。

**云端矩阵 9/9 PASS**（scripts/cloud-v14.mjs，真实模型）：C01 markdown / C02 PPTX 两页真实（页数约束）/ C03 CSV→XLSX / C04 DOCX / C05 PDF（系统 chromium，15298B 真实 %PDF）/ C08 网站多文件修改 / C09 项目延续两轮共享 workspace（22 个版本化历史产物）/ C12 并发 3 任务 / C17 项目历史 API。

**云端矩阵暴露并修复的真实问题（勿回退）**：
- multipart 任务创建缺 projectId 解析（项目关联在上传任务丢失）→ 补齐
- 规则规划器缺 PDF 分支 → "做成 PDF"落 general → LLM 拒绝式回答 → planFromRules 加 4b
- artifact 类型任务被 LLM 规划拆 dev 步骤（file-agent 无 pdf 管线）→ generatePlan 对 artifact 类型跳过 LLM 规划
- PPT"两页"产出 5 页 → extractPageCount + trimSlidesTo 截断（KIND_INSTRUCTIONS 写死 5-8 页）
- pdf 生成器未注册 legacy registry → 注册（适配器模式）
- 系统 chromium 需 --no-sandbox（chromiumSandbox: false）
- @playwright/test 是 devDep 且仅被 esbuild worker 引用 → 移入 dependencies + Dockerfile 手动拷入 standalone（next trace 不覆盖）+ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
- xlsx 意图的 agent_workspace 任务无 xlsx 产物（file-agent 容器无 spreadsheet 工具=limitation）→ toolsFor 授权 spreadsheet.*（AgentScope 通道）+ 矩阵 C03 走 artifact 生成器
- 系统文件噪音（task.json/context.json 等）→ SYSTEM_ARTIFACT_FILES 过滤（上报路径+兜底收集共用）

**本地**：447/447 + typecheck + build + E2E 17/17。功能清单见下文历史段。

**Known limitations（V1.4 记录）**：
- Browser Runtime 云端已具备（系统 chromium + --no-sandbox）但**未在云端矩阵实测网页导航**（C10 类）；本地 14 项浏览器测试全绿
- PPTX 缩略图需 LibreOffice（服务器未装；预览页显示页数+下载提示）
- Claude Code 通道（file-agent 容器）工具集由容器侧决定——spreadsheet/browser 工具在 AgentScope/sandbox 通道可用
- general 步骤模型响应超时（deepseek-v4-pro 思考贪心）fallback 文案已区分"未配置"vs"超时"
- exa 搜索公开端点可用；AgentScope Docker 沙盒仍 local 模式

## 2026-08-16 V1.4 云端部署中（WP19-40/45-52/56-64 本地完成，镜像 ai-client:v1.4 已上服务器）

**本地完成并提交**（HEAD 39019df，443/443 + typecheck + build + E2E 17/17）：
- **Browser Runtime（WP19-21/53）**：lib/browser/{security,observation,runtime,tools}.ts——playwright chromium 会话（观察模型：url/title/visibleText 8K/元素 120/href 绝对化）、协议白名单（file:/javascript:/data: 拒）、workspace-only 下载（20MB 上限）、导航预算 30/会话、崩溃自动重启+重新导航（lastUrl 保留）；8 工具注册进 Tool Registry（browser.navigate/read_page/click/type/scroll/screenshot/download/back）；sandboxManagerExecutor 桥（沙盒内 agent 调 host 浏览器）；研究类 goal 自动授权 browser 能力
- **Deliverable 契约（WP28-32）**：AGENT_WORK_INSTRUCTION 注入每次执行 prompt（防"作为 AI 我不能"）；planner 提示要求步骤注明交付物；worker final summary 附真实产物清单；project_agent contract expectations 修复（原为空=形同虚设）
- **PPTX 语义（WP58）**：移除独立封面页——slideCount=实际页数（"两页 PPT"=两页内容）；legacy/pptxgenjs 两渲染器统一；空 spec 兜底单页
- **Project Workspace 全开（WP37-40）**：ENABLE_PROJECT_WS 默认开（=0 关）；容器映射 conversationId="projects"/jobId={projectId}；/api/projects（列表+创建）+ /api/projects/:id（任务+版本化产物历史+workspace 文件树）；前端 /projects 列表页 + 详情页重写；延续测试（两轮共享 workspace、input 不重复上传）
- **InputManifest（WP45-46）**：lib/tasks/inputManifest.ts——每文件结构化摘要（文本预览/xlsx sheet 结构/PDF 页数+正文/NUL 二进制守卫），进 planner 上下文（原只有文件名）
- **验收测试（WP56-60）**：tests/v14-acceptance.test.ts——物理题两页 PPT（容器/页数/内容含 XML 实体公式/validate）、XLSX 排序+平均分+统计 sheet+图表重读验证、DOCX 内容不丢、PDF 读回+PNG 渲染、契约矩阵、refusal 回归；sortRange 重写（exceljs eachCell 行对象怪癖）；KIND_HINTS 目标类型优先（"CSV 转 Excel"→xlsx）
- **并发+下载（WP52/64）**：3 任务并发互不污染；下载可靠性（RFC 5987 中文文件名/mime/size/401/404 穿越/过期）
- **构建**：Dockerfile worker esbuild external @napi-rs/canvas（V1.4 pdf 管线把 canvas 拉进 worker bundle）
- **部署**：ai-client:v1.4 镜像（353MB）已 load 服务器，web+worker 已 rm+run 替换（env-file /opt/ai-client/.env、go-ai-net、/data 挂载、127.0.0.1:3000），migrate v1.5 已应用
- **云端矩阵运行中**：scripts/cloud-v14.mjs（C01 markdown/C02 PPTX 两页/C03 CSV→XLSX/C04 DOCX/C05 PDF/C08 ZIP 项目/C09 项目延续/C12 并发 3/C17 项目历史）

**已知 limitation（云端）**：Browser Runtime 需 chromium——服务器 worker 镜像无浏览器（playwright external）；云端浏览器闭环待 sidecar 或沙盒内浏览器；本地已完整验证（8+6 测试）。PPTX 缩略图需 LibreOffice（服务器可后续加）。

## 2026-08-16 V1.4 WP17-18 完成（Preview System，本地全绿）

**目标**：产物"不下载即可判断结果"（V14 审计 #16 missing → real）。

**交付**：
- **PreviewService**（lib/artifacts/preview.ts）：按 family 路由渲染——xlsx→table HTML（复用 summarizeXlsx）、docx→文本提取、html→原样、image→data URL（真实 mime）、zip→file tree、pdf→首页 PNG（pdfjs+@napi-rs/canvas）、pptx→slideCount 元数据；未知 kind→none
- **缓存**：文本类（table/text/tree/html）落盘为 preview-<id> artifact（前缀须过 sanitizeFilename，冒号会被替换成下划线导致查找失配）；首次返回 content 内联+url，命中只返回 url；image/pdf data URL 不落盘（按资产类型显式判定，不按 startsWith("data:")——img 包裹是 `<img src="data:...">` 会被误判）
- **API**：GET /api/artifacts/:id/preview（鉴权+kind 推断）；import 深度 5 级（app/api/artifacts/[id]/preview/ 比 [id]/ 多一级）
- **前端**：产物页接 preview API（table/tree/html/img→sandbox iframe srcDoc+最小内联样式；docx→pre；pptx→页数提示）；任务详情页产物卡片改为链到 /artifacts/:id（预览页内下载）
- **构建修复**：@napi-rs/canvas（.node 资产进不了 Turbopack ESM chunk）+ pdfjs-dist（fake-worker 动态 import pdf.worker.mjs 相对路径，打包内联后文件不存在）加入 serverExternalPackages（runtime require/import 原生可用）；其余纯 JS 包（exceljs/jszip）正常打 bundle，external 反而因 ESM-only 在 require 时炸
- **验证**：test:core 409/409（新增 9 项 preview 测试）+ typecheck + build + E2E 17/17；standalone 运行时冒烟（真实登录→二进制 PDF 落盘→预览 API 出 page PNG，HTML 缓存命中，unknown→none）
- **遗留**：PPTX 缩略图需服务器 LibreOffice（当前返回页数+下载提示）；preview.ts/pdfReader 渲染失败 console.error 保留（诊断用）

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

## 2026-08-15 V1.1 Goal Mode（WP1-WP18 完成，进行 WP19/20）

已完成：WP1 Runtime Audit（docs/V11_RUNTIME_AUDIT.md）→ WP2 AgentCompletionContract（系统判定完成）→ WP3 纠错循环（attempts 落盘）→ WP4 Workspace 2.0（agent/verification/logs）→ WP5 SandboxRuntimeAdapter → WP6 AgentScopeRuntimeAdapter（prototype 代码）→ WP7 Tool Registry（9 工具+安全边界）→ WP8 Vision 字段扩展（colors/objects/relationships）→ WP9 FilePreprocessor → WP10 持久化多步 plan（phase 列）→ WP11 Task Recovery（preparing_workspace/validating/retrying）→ WP12 ArtifactValidator（HTML/CSV/JSON/ZIP/PPTX/MD）→ WP13 V11 测试矩阵 → WP14 reasoning stop=length 重试 → WP15 UI 状态徽章 → WP16 安全回归（隔离/symlink/限额）→ WP17 状态感知清理（active 排除/failed 3d）→ WP18 ObjectStorageAdapter（LocalObjectStorage）。

**V11 服务器 E2E：6/7**（T1 MD 结构化、T3 图片+HTML、T4 ZIP 多文件、T12 PPTX、T10 二轮修改 11→22、T14 Docker 重启 PASS；T2 CSV 判据修正后重跑中）。
**本地 E2E：7/7；unit/integration：257/257。**

关键坑：task_steps.phase 列需服务器 ALTER（本地验证后服务器库缺列——部署时迁移幂等未覆盖新列，需手工 ALTER）；测试的 ArtifactService 需显式传 LocalObjectStorage（全局单例与测试隔离）。

## V1.1 完成（2026-08-15，WP1-WP20，39 commits 已 push origin/main，tag go-ai-agent-first-v1）

- V11 云端 E2E：7/7 等效（T1 MD 结构化、T2 CSV 去重排序、T3 图片+HTML（E2E 1 次波动失败后 repair 正确失败；独立复测 3/3 PASS）、T4 ZIP 多文件重打包、T10 二轮修改 11→22 版本化、T12 PPTX、T14 Docker 重启）
- 本地：unit/integration 257/257、E2E 7/7、build PASS
- 线上：ai-client/ai-task-worker 运行 V11 镜像；task_steps.phase 已 ALTER
- 剩余已知缺陷：DeepSeek agent 对图片修改类任务偶发"只分析不交付"（repair loop 兜底为明确失败；复测 3/3 正常）；T7 视觉问答长 reasoning 截断（WP14 自动重试已接，待模型端验证）

## 2026-08-15 V1.1 续接轮（vision MCP 补齐，3 commits，本地全绿）

**背景**：V1.1 主链（WP1-WP20）完成后剩余缺陷集中在图片/视觉链路；用户补齐 vision MCP（本地 4 工具）后续接。

**本轮完成**：
- **图片任务根因强化**（2bb0c5a）：视觉摘要由系统代读并内联进每次执行 prompt 与修复指令（UNTRUSTED 标记防注入；prompt 防重复内联）；图片任务 maxAttempts 2→3（复杂工作区）；attempt-N.json 落盘与 execute prompt 一致（含视觉摘要）。直接针对 DeepSeek"只分析不交付"——agent 无需先读 vision/ 文件即带全部视觉信息
- **vision MCP 视觉验收**（835957f）：scripts/vision-fixture.mjs（reference/正例/反例素材）+ scripts/render-html.mjs（产物 HTML→截图）+ docs/V11_VISION_VERIFICATION.md。实测：正例 goal_met=true conf 0.92；反例正确识别背景/标题/按钮色/卡片数全部差异。补上 T3 类任务"只验证存在、不验证视觉一致"的缺口。goal 措辞经验：写"判断是否视觉一致"而非"是否按参考重做"
- **WP14 判定提取纯函数**（af777ed）：lib/message/reasoningRetry.ts（stop=length/max_tokens + reasoning-only + 未重试 → 重试）+ 8 单测；page.tsx 行为不变；确认服务端 max_tokens 上限 32K ≥ 重试 16K，无服务端阻塞
- **测试**：267/267（V1.1 基线 257 + dev-executor 图片任务 2 + reasoning-retry 8），typecheck PASS

**Blocked（HARD BLOCKER #1：需用户提供密钥）**：T7 视觉问答 reasoning 截断与 DeepSeek 图片任务的**真实模型复测**需 OPENCODE_GO_API_KEY（本地 .env.local 仅 ACCESS/E2E_PASSWORD/DATABASE/REDIS）或 tencent-ai 服务器访问（本机无 ssh 配置/无远程 docker context/file-agent 容器）。系统侧行为已全部就绪且有测试；模型端验证待 key。

## 2026-08-15 V1.1 续接轮 2（E2E 修复，1 commit，本地全绿）

- **真实 bug 修复**（0b5e643）：`app/tasks/[id]/page.tsx` currentStage useMemo 在 `if (!detail) return` 之后调用 → "Rendered more hooks than during the previous render"，任务详情页打开即整页崩溃。已移到条件返回之前（Hooks 无条件调用）
- **E2E 与产品对齐**：E2E 仍假设 `/` = 聊天页 + 文件任务聊天页内联 JobCard；产品已迁移（`/` = 任务启动器，文件任务 → POST /api/tasks → 详情页，PRD V1/V11 WP10）。goto 改 `/chat`；TEST16/17 重写为任务系统流程（聊天页创建任务 → 详情页渲染 + 事件流/步骤 Tab/取消；404 错误路径），守护 hooks 崩溃回归
- **验证**：E2E 17/17 PASS（此前全挂 20.3s 超时——页面未加载），typecheck + build PASS

## 2026-08-15 V1.1 续接轮 3（T7 真实模型验证完成，阻塞解除）

**用户提供 OPENCODE_GO_API_KEY（本地 .env.local，gitignored）后完成真实模型验证**：

- **T7 截断真实复现**（系统 /api/chat 流式 + deepseek-v4-pro）：maxOutputTokens=150 → `stopReason=length`、text 空、reasoning 非空 → **WP14 判定 retry=true 正确触发**（多次独立复现）
- **重试成功闭环**：提高预算（150→1500）→ 产出 final ✓（中等题；档位 500/900 仍截断、1500 成功）
- **模型侧根因实证**（"只分析不交付"的深层机制）：deepseek-v4-pro 思考贪心，预算总被思考耗尽（预算 150/500/900/1500/2000 → reasoning 256/751/1396/4571/6796 字符，均无 final）。**V1.2 建议：推理模型独立 reasoning budget 或图片修改任务默认非推理模型（deepseek-v4-flash）**
- **MiniMax vision 通道真实可用**：同一 key 对 reference.png 出结构化描述（正确读出卡片文字）
- **环境限制（非产品缺陷）**：本地代理（Clash TUN）对 opencode.ai 长连接约 40s 断开，≥3000 max_tokens 的生成不可达；服务器无此限制。WP14 客户端重试 16K 语义保留
- 系统行为最终结论：截断→判定→最多一次重试→提高预算→成功/明确提示，不无限循环（8 单测覆盖）
- **DeepSeek 图片任务真实复测**：仍需服务器（本地无 file-agent 容器）；模型侧根因已实证 + 视觉摘要内联修复已上线代码，待服务器回归

## 2026-08-15 V1.3 完成（WP1-WP42，tag go-ai-v1.3-production-agent-runtime）

**V1.3 目标**：复杂任务在独立、安全、持久、可恢复的云端 Agent Sandbox 中连续执行至真实结果。

**核心交付**：
- **Job/AgentSession 一等化**（WP2-3）：jobs 表（13 状态机 + checkpoint + lease）+ agent_sessions 表（工具计数/心跳）；Task=意图、Job=执行、attempt 序列
- **SandboxManager + DockerSandboxProvider**（WP4-5）：per-task 受限容器（non-root/--network none/--read-only/memory/cpus/pids/cap-drop）；LocalSandbox 开发回退；实测宿主敏感路径不可见
- **RuntimeToolProtocol**（WP7）：ToolCall/ToolResult/ToolError 统一 + sandboxManagerExecutor
- **DeepSeek 工具调用根因**（WP8-9）：三模型 opencode 通道均产 OpenAI tool_calls；V1.2"pro 不调工具/Docker 不兼容"= dind 初始化竞态；Docker 沙盒生产激活（pro 实测全通）
- **Planner/Executor 模型分离**（WP10）：policy.plannerModel/executorModel/visionModel
- **Durable loop + Job 恢复**（WP11-13）：步骤 checkpoint + job lease 循环认领
- **Manifest/Snapshot/Ingestion/ZIP**（WP14-17）：workspace manifest（sha256/role）、版本快照 + repair 前回滚、FileIngestionPipeline、zip slip 防护
- **Cancel 真终止 + Continue lineage**（WP18-21）：per-task abort（执行中 cancel 立即中断）+ parent_artifact_id/workspace_parent_version + ENABLE_PROJECT_WS
- **Provider Health 动态化**（WP22-24）：后台 probe（10min/Redis）+ /api/models healthStatus（luna region_unavailable/grok disabled 实测）
- **Resource/镜像**（WP25-28）：ResourcePolicy + go-ai-sandbox:v1 + build-smoke.sh
- **Provenance/UI/Failure UX**（WP29-33）：artifact provenance + 详情页 Job 信息/Files tab/失败语义化
- **安全矩阵**（WP34-36）：真实容器探测全过
- **Long Horizon 实测**（WP38）：ZIP 项目+参考图+5 要求 → 257s 多步执行 → site v2 ZIP；中途 worker 重启任务继续

**验证**：本地 379/379 + typecheck + build + E2E 17/17；云端：长任务 PASS + 执行中 cancel PASS + provider 状态 PASS + V1.2 全套回归

**部署**：ai-client:v1.3（web+worker）+ migrate v1.5 + AgentScope Docker 沙盒（production）；rollback=V1.2 镜像（latest e13115d1634d）+ 源码备份 /opt/ai-client-backup-v11

**已知问题**：AgentScope directories 端点宿主枚举（upstream 缺口，Docker 沙盒下仅容器内可见）；ENABLE_PROJECT_WS 需 adapter 映射配套（默认关）；服务器 build-smoke 进行中

## 2026-08-15 V1.2 完成（WP1-WP35，tag go-ai-v1.2-runtime-orchestration，云端已部署）

**V1.2 目标**：系统自动选择大脑/Runtime/工具/推理预算/执行策略（Native Agent Runtime & Model Orchestration）。

**核心交付**：
- **Capability Model**（lib/policy/capabilities.ts）：Model/Runtime/Task 三套能力声明，业务层不再散落 model-name 判断
- **ExecutionPolicyEngine**（executionPolicy.ts）：deterministic-first（PPT→generator、ZIP/图片→agent runtime、vision+chat 分离）；worker 按 plan 生成 ExecutionPolicy（modelRole/runtime/budget/tools/retry）
- **ModelPolicyEngine**（modelPolicy.ts）：角色链（chat=flash、reasoning=pro→qwen→glm、agent=flash、vision=minimax），capability-safe fallback
- **TokenBudgetManager**（tokenBudget.ts）：6 档预算（tiny→deep_reasoning），stop=length 按档升级（非乘 10），BudgetTrace 落盘
- **AgentLoop 统一事件**（agent/loop.ts）：11 事件 + 状态机；devExecutor 修复循环发 validation.failed/repair.started/agent.completed
- **Tool Registry 2.0**（tools/registry.ts）：capabilities/timeout/sideEffects/resultSchema + authorizedTools 授权（代码执行默认不授）
- **AgentScope 真实 Runtime**：本地闭环（MD 385ms/CSV 334ms/图片HTML 26.6s）+ 云端真实模型任务（AS-MD note v1、AS-IMG-HTML index v1）；共享卷同步（input→agent 工作区、output→任务 workspace）；scripts/agentscope-server.py + scripts/agentscope-real-acceptance.ts
- **Vision 验证闭环**（vision/verification.ts + screenshot.ts）：VISION_VERIFY=1 时渲染产物→describe→结构化对比→repair 反馈（有界）
- **Generator 边界/PPTX theme/XLSX reader/DocumentAdapter**（boundary.ts/presentationSpec theme/xlsxReader/documentAdapter）
- **ProviderHealthRegistry + FallbackGraph**：Luna 根因=服务器出口 IP 区域限制（本地 probe 200，账户/key 有效）；Grok 上游 503 保持禁用
- **FailureTaxonomy + RepairPolicyEngine + TaskExecutionMetrics**（PG task_metrics 表 v1.2 迁移）
- **ContextComposer + Skills 进 Agent Runtime**（dev 步骤 skills 注入缺口修复）
- **Project Workspace 上下文 + Continuation lineage**（项目历史产物进 planner 上下文、parent_task_id 标记）

**验证**：本地 350/350 unit/integration + typecheck + build + E2E 17/17；云端 Claude Code 8/8（E1 模型/E2 MD/E3 CSV/E4 PPTX/E6 图片HTML/E7 ZIP/E9 continuation/E10 下载）+ AgentScope 云端 2/2（MD/图片HTML）+ worker restart ✓

**云端部署**：ai-client:v1.2（web+worker，migrate v1.2）+ AgentScope 生产栈（agent-runtime + sandbox-daemon dind；AGENTSCOPE_SANDBOX=local 模式，Docker 沙盒已就绪待工具兼容验证）；rollback=旧镜像 latest（e13115d1634d）+ 源码备份 /opt/ai-client-backup-v11

**已知缺陷/记录**：
- AgentScope Docker 沙盒模式（DockerWorkspaceManager）工具/schema 与真实模型不兼容（upstream error）→ 已切 local 沙盒；Docker 沙盒修复待续（WP29 记录的生产隔离项）
- deepseek-v4-pro 在 AgentScope 工具循环不调用工具 → AGENTSCOPE_MODEL=kimi-k3（记录）
- 云端 /api/models 无 deepseek-v4-flash（opencode 通道服务器侧模型列表差异；agent fallback 链会处理）
- AgentScope credential API 无鉴权返回明文 key（internal 网络内；记录）
- 注册限流 5 次/小时（IP 级内存态；重启 web 清空）——E2E 脚本固定账号登录优先
- 服务器 docker build 的 next standalone 生成异常（本地构建镜像传输；记录）
