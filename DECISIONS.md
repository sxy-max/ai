# Go AI — Locked Decisions

不可随意推翻，除非出现无法解决的技术阻断。

1. **File Agent = Claude Code + DeepSeek V4 Flash**（默认）。不换 OpenCode Agent，不默认升 Pro。
2. **视觉统一 MiniMax**（minimax-m3）。MiniMax 负责"看"。
3. **File Agent 安全**：workspace 隔离、非 root、cc-auth-gateway（真实 key 不进 agent 容器）、无 docker socket、无 host 文件系统、API 不公开公网。**Bash 保持 deny**（sandbox Bash 放到核心完成后的独立阶段）。
4. **网络基础设施冻结**：sing-box / Docker daemon proxy / DNS / Nginx 基础策略。无新网络证据不动。
5. **Kimi K3 temperature 固定 1**，服务端兜底。模型各自 capability/parameter policy。
6. **reasoning 是独立 part**，绝不并进 content；不进入下一轮 upstream。
7. **空 assistant 三层防御**（创建/发送前/加载时）。reasoning-only = incomplete。
8. **Artifact 是一等消息内容**。HTML>100 或明确要求 → 从 content 真正删除 raw，转 artifact。
9. **个人化用 localStorage**（无账号系统），不共享服务器全局 Profile。
10. **本地优先开发**（D:\Projects\go-ai），云端只部署+回归。
11. **按功能 commit**（typecheck+build 通过），push → 云端 pull → Docker 部署。
