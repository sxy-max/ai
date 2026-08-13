# Go AI — Acceptance

Feature Build 完成标准（全部 IMPLEMENTED）。状态: [x]=已实现, [~]=已实现未浏览器验证, [ ]=未完成

## 核心能力
- [x] 多模型正常选择（7 精选模型）
- [x] Grok/Qwen quota（服务端持久化，成功才计数）
- [x] Kimi temperature policy（固定 1）
- [x] Streaming
- [x] Reasoning UI（折叠/独立 part）
- [x] Markdown
- [x] KaTeX
- [x] 表格
- [~] 代码高亮（rehype-highlight + hljs 双主题 token，E2E 验证中）
- [~] 一键复制（message + code，E2E 验证中）
- [~] 自动主题（system/light/dark，CSS tokens 双主题，待浏览器验证）
- [x] 图片粘贴
- [x] 图片上传
- [x] MiniMax Vision（独立链路）
- [~] 普通图片聊天（image → MiniMax → 当前模型，服务端兜底 + 单测过，待线上回归）
- [~] 图片+文件 Agent 闭环（云端实测过 vision→file）
- [x] 文件上传（multipart → workspace）
- [x] 文件下载（Artifact）
- [x] Artifact（create/download/expire 检测）
- [x] HTML>100 自动文件化（transform + 接入主链）
- [x] 明确文件请求直接文件化
- [x] File Agent（Claude Code headless）
- [x] 文件真实编辑（Read/Edit/Write）
- [x] ZIP 项目处理
- [~] Artifact 历史（刷新可见）
- [~] Memory（localStorage，CRUD/启停）
- [~] Response Style（4 预设 + 自定义，独立注入）
- [~] 用户 Skills（SKILL.md 导入/启停）
- [~] Skills 进入普通 Chat（相关性选择 + [USER SKILLS]）
- [~] Skills 进入 File Agent（task skills 字段转发）
- [~] MCP/Tool Registry 基础（内置工具按任务解析 + /api/tools + 外部注册默认关闭）
- [~] 模型可用性状态（MODEL_REGION_UNAVAILABLE / TEMP_UNAVAILABLE / NOT_FOUND / 上游 quota → 友好中文，不暴露原始错误）
- [~] Settings 页（主题/联网/上下文/Reasoning/温度/Max output，模型能力禁用）
- [x] Sidebar 个性化入口（底部 个性化/设置 导航）
- [x] 联网（Exa MCP）
- [x] URL fetch

排除：宠物（完全退出）；语音（Conditional/Future）。
