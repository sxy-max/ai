# Go AI — Product Goal

长期目标：把 Go AI 做成一个真正可长期使用的 AI Client + 文件 Agent 客户端。
Feature Completion First → Stabilization Second → Final Validation。

## 产品终态核心
- 聊天：Streaming / Reasoning 折叠 / Markdown / KaTeX / 表格 / 代码高亮 / 一键复制 / 文件卡片 / 图片 / 联网 / 多轮上下文 / 历史
- 模型：7 精选模型（gpt-5.6-luna/grok-4.5/kimi-k3/qwen3.8-max/glm-5.2/minimax-m3/deepseek-v4-pro）+ per-model parameter policy（kimi-k3 temp 固定 1）
- 配额：Grok/Qwen 各 5/5h + 20/7d，服务端持久化，成功才计数
- 图片：粘贴+上传 → MiniMax Vision → 结构化上下文（UNTRUSTED）→ 当前模型；图片+文件 Agent 闭环
- 文件：真上传(workspace) / Artifact 下载 / HTML>100 自动文件化 / 明确请求直接文件化 / File Agent 真编辑 / ZIP 项目
- 个性化：Memory(localStorage) / Response Style(4种) / 用户 Skills(SKILL.md)
- UI：自动主题 / Settings / Sidebar 底部(个性化/设置) / 一键复制 / 顶部只留模型名
- 安全：File Agent sandbox（非root/无docker socket/无host/cc-auth-gateway/真实key隔离），Bash deny

## 明确排除
- 宠物（完全退出）
- 语音（Conditional/Future，不阻塞）

## 完成定义
见 ACCEPTANCE.md 清单。全部 IMPLEMENTED 才算 Feature Build 完成。
