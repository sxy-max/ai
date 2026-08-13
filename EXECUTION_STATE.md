# Go AI — Execution State

## 已完成并实现（云端已部署，本地已同步）
- **2026-08-13 两次上线**：Feature Build 大版本 + Stabilization 批次（storageSafeMessages key 修复）。线上回归确认 kimi 完整流 meta+reasoning+text+done、vision-chat、登录/模型/公网 200。
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
- **E2E 13/13 全过**（12s）：reasoning 折叠/重试/多轮/user+assistant KaTeX/HTML artifact/刷新持久/代码高亮+复制/message 复制/Settings+主题/个性化记忆/旧格式迁移/移动端
- Stabilization：storageSafeMessages 补旧消息 id（修 React key 警告）、旧 schema 迁移 E2E、KaTeX 复杂公式单测、移动端布局 E2E
- 本地：lib/message/{types,lifecycle,transform}.ts、单测 41/41 过、typecheck/build 过

## 正在做
- 云端部署已上线（2026-08-13）：git push → tar/scp → docker build → 替换容器（保留 go-ai-net/unless-stopped/2GB//data volume/env-file）
- 线上回归全绿：公网200 / 登录 / 模型7个 / kimi 真实流式 / **glm无视觉+图片→MiniMax→回答** / personalization+skills 注入 / File Agent 上传→任务→artifact

## 待做（按依赖排序）
1. Stabilization 收尾：公网浏览器视觉回归（可选）、长对话上下文压测
2. 长期 backlog：语音（Conditional/Future）、sandbox Bash（独立阶段）、真实模型差异回归

## Blocked
- 无

## 已验证
- 云端（历史）：File Agent 三测试、ZIP、vision→file、Artifact 下载、安全 8-10、重启恢复
- **云端（本次部署回归）**：vision-chat 预处理、真实流式聊天（kimi meta+reasoning+text+done）、**真实模型多轮上下文（kimi 两轮回忆暗号）**、personalization/skills 注入、File Agent 链路、公网 200
- 本地：typecheck/build/单测 41/41、**E2E 13/13 全过**（reasoning/KaTeX/artifact/复制/高亮/设置/个性化/迁移/移动端）
- E2E 基础设施根治：Next16 allowedDevOrigins + reuse=false + globalSetup 预热 + selectModel 按 value

## 未验证
- 公网浏览器物理视觉回归（API 层已回归；UI 由 E2E mock 覆盖）、长对话上下文压测

## Stabilization Backlog
- ~~E2E "Target crashed"~~ 根因已修复：Next16 dev 跨源保护（allowedDevOrigins 未含 127.0.0.1 → 浏览器 Origin 头的 chunk/HMR 请求 403，app 不 hydrate；curl 无 Origin 故正常）。已加 allowedDevOrigins + globalSetup 预热
- KaTeX 复杂公式视觉细节（V_eff'' 类）
- 历史 schema 迁移完整性
