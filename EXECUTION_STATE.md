# Go AI — Execution State

## 已完成并实现（云端已部署，本地已同步）
- 网络基础设施：sing-box(Docker proxy) / Nginx / Docker / go-ai-net（冻结）
- File Agent 底层：Claude Code + DeepSeek V4 Flash、cc-auth-gateway、go-ai-file-agent 容器（非root/仅workspace）、单并发+15min超时、Bash deny
- 模型系统：7 精选模型 + KNOWN_VISION(kimi=true,glm=false) + modelPolicy(kimi temp=1) + 配额(quota.ts 持久化)
- 文件能力：/api/files/upload、/api/agent/task(带 vision)、/api/artifacts/create、/api/artifacts/[id]、ZIP 解压/重打包、MiniMax Vision
- 前端（云端同步）：MessageParts 统一 renderer、P0 修复（reasoning-only 防呆/三层 Empty 防御/用户 KaTeX/HTML 替换）
- 本地：lib/message/{types,lifecycle,transform}.ts、单测 11/11 过、Playwright 配置 + mock 模型

## 正在做
- E2E 稳定化（Playwright chromium + Next dev 崩溃——记录为 Stabilization Backlog，不阻塞功能）

## 待做（按依赖排序）
1. 一键复制 message/code（云端已实现，需本地回归确认）
2. 图片粘贴/上传 → MiniMax Vision → 普通聊天（云端 paste 已实现；vision-chat 未接）
3. 自动主题（light/dark/system）
4. Settings 页 + Sidebar 底部（个性化/设置）
5. Memory(localStorage) + 注入
6. Response Style + 注入
7. 用户 Skills 导入/启用 + 注入（普通 Chat 路由 + File Agent CLAUDE.md）
8. 模型可用性状态（403/503 → 友好提示）
9. MCP/Tool Registry 基础

## Blocked
- 无

## 已验证
- 云端：File Agent 三测试、ZIP、vision→file、Artifact 下载、安全 8-10、重启恢复
- 本地：typecheck/build/单测 11/11

## 未验证
- Playwright e2e（浏览器崩溃）
- 手机端、真实模型多轮、公网回归

## Stabilization Backlog
- E2E "Target crashed"（Playwright+Next dev 交互）
- KaTeX 复杂公式视觉细节（V_eff'' 类）
- 历史 schema 迁移完整性
