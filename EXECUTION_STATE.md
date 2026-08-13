# Go AI — Execution State

## 已完成并实现（云端已部署，本地已同步）
- 网络基础设施：sing-box(Docker proxy) / Nginx / Docker / go-ai-net（冻结）
- File Agent 底层：Claude Code + DeepSeek V4 Flash、cc-auth-gateway、go-ai-file-agent 容器（非root/仅workspace）、单并发+15min超时、Bash deny
- 模型系统：7 精选模型 + KNOWN_VISION(kimi=true,glm=false) + modelPolicy(kimi temp=1) + 配额(quota.ts 持久化)
- 文件能力：/api/files/upload、/api/agent/task(带 vision)、/api/artifacts/create、/api/artifacts/[id]、ZIP 解压/重打包、MiniMax Vision
- 前端（云端同步）：MessageParts 统一 renderer、P0 修复（reasoning-only 防呆/三层 Empty 防御/用户 KaTeX/HTML 替换）
- 视觉预处理：lib/vision.ts（共享 MiniMax describe）+ /api/chat 服务端兜底（非 vision 模型图片→UNTRUSTED VISUAL CONTEXT）+ 客户端 visionUsed chip / 视觉分析中状态（单测 22/22 过、build 过）
- 主题：CSS tokens 双主题（:root 深色 / [data-theme=light] 浅色），设置里 自动/浅色/深色
- 设置/个性化：Settings 视图（主题/联网/上下文/Reasoning/温度/Max output，参数随模型能力禁用）+ Sidebar 底部导航
- 个性化：lib/personalization.ts（Memory localProfile + Style 4预设/自定义 + Skills SKILL.md 导入/相关性选择），注入独立 system 段（[USER MEMORY]/[RESPONSE STYLE]/[USER SKILLS]），聊天+File Agent 双路由
- 可用性错误：lib/modelErrors.ts（MODEL_REGION_UNAVAILABLE/MODEL_NOT_FOUND/MODEL_QUOTA_EXCEEDED_UPSTREAM/MODEL_TEMP_UNAVAILABLE），流内错误友好翻译，客户端映射
- Tool Registry：lib/toolRegistry.ts（内置 web_search/url_fetch/vision/file_agent + 外部注册默认关闭）+ /api/tools，page 的搜索/视觉/文件路由决策收敛到 registry
- 代码高亮 + 复制：MessageParts rehype-highlight + CodeBlock 一键复制（此前 page.tsx CodeBlock 是死代码，复制从未生效，已修复）+ hljs token 双主题调色板
- E2E：Playwright 复用了残留非 E2E dev server 导致登录页 → reuseExistingServer=false + 清理端口；E2E 全量重跑中
- 本地：lib/message/{types,lifecycle,transform}.ts、单测 35/35 过、Playwright 配置 + mock 模型

## 正在做
- E2E 稳定化（Playwright chromium + Next dev 崩溃——记录为 Stabilization Backlog，不阻塞功能）

## 待做（按依赖排序）
1. E2E 全量回归确认（浏览器验证复制/高亮/生命周期）
2. 云端部署 + 线上回归（vision-chat / Skills / 个性化 / Artifact 历史）
3. Stabilization：mobile / 真实模型多轮 / history schema / 剩余 backlog

## Blocked
- 无

## 已验证
- 云端：File Agent 三测试、ZIP、vision→file、Artifact 下载、安全 8-10、重启恢复
- 本地：typecheck/build/单测 35/35；E2E 配置已修复（reuse=false + 端口清理）

## 未验证
- E2E 浏览器回归（重跑中）
- 手机端、真实模型多轮、公网回归、云端 vision-chat 预处理

## Stabilization Backlog
- ~~E2E "Target crashed"~~ 根因已修复：Next16 dev 跨源保护（allowedDevOrigins 未含 127.0.0.1 → 浏览器 Origin 头的 chunk/HMR 请求 403，app 不 hydrate；curl 无 Origin 故正常）。已加 allowedDevOrigins + globalSetup 预热
- KaTeX 复杂公式视觉细节（V_eff'' 类）
- 历史 schema 迁移完整性
