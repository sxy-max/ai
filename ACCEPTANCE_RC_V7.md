# Go AI Cloud Agent Workspace v7 Acceptance

> Release Candidate Acceptance — 2026-08-13
> 版本锁定，只做验收，不开发新功能。

## 1. 版本信息

| 项 | 值 |
|---|---|
| Local commit | `413783953ae662bd2e2a74773fb8d3164d1c7a63`（`4137839`） |
| GitHub commit | `413783953ae662bd2e2a74773fb8d3164d1c7a63`（origin/main 权威值，2026-08-13 ls-remote） |
| Cloud commit | `413783953ae662bd2e2a74773fb8d3164d1c7a63`（/opt/ai-client） |
| Docker image | `f996db89ae4f`（ai-client:latest，build 2026-08-13 23:32:39 +08） |
| Deploy time | 2026-08-13 23:33 +08（容器 started 2026-08-13T15:33:06Z） |
| Server | tencent-ai（122.51.78.4，腾讯云） |
| Public URL | http://122.51.78.4/ |
| Main containers | ai-client（127.0.0.1:3000）、go-ai-file-agent（18082）、cc-auth-gateway（18081）、cc-precheck |
| Data volume | `/opt/ai-client/data` → 容器 `/data`（workspaces/ + artifacts/，bind mount） |
| Rollback target | 上一稳定镜像 `sha256:004496a07…`（见 §6） |

**一致性结论：本地 = GitHub = 云端 = Docker 镜像，四处完全一致。**

云端工作树非代码差异（不影响运行，不修）：
- `.env.example` 有本地改动（部署侧遗留，非敏感、非运行依赖）
- `data/` 未跟踪（运行数据：workspaces/artifacts/，属正常）

## 2. 已完成能力

按真实能力列（均有回归/单测/E2E 依据，无宣传语）。

1. **普通聊天**：多轮流式，reasoning 折叠，final answer，刷新恢复最近对话
2. **模型调用**：kimi-k3 / glm-5.2 / qwen3.8-max / minimax-m3 / deepseek-v4-pro 实测可调用（"只回答OK" 200+streaming+done）；kimi-k3 可看图
3. **Grok 下架状态**：grok-4.5 上游 503（Endpoint unavailable），已在列表但不可调用
4. **GPT Luna 状态**：gpt-5.6-luna 上游 403（not available in your region），保留研究、不可作核心
5. **Task Router**：R1 把「生成…ppt/html/csv」等显式文件请求路由到确定性生成器 `/api/tasks`，其余走 chat streaming
6. **Artifact Service**：`/data/artifacts` + manifest，创建/读取/过期/绑定 job；过期在读取时强制（normalizeArtifact）
7. **HTML Artifact**：确定性自包含单文件（用户文本转义防注入），可下载
8. **Markdown Artifact**：确定性 md 生成器，可下载
9. **CSV Artifact**：确定性表/键值对生成，公式注入防护（=+-@ 前缀加撇号），可下载
10. **PPTX Artifact**：确定性 pptx 生成（jszip），可下载，PowerPoint/WPS 可打开
11. **文件上传**：`/api/files/upload` multipart → workspace/input（ALLOWED_EXT 白名单）
12. **文件下载**：`/api/artifacts/<id>` 认证下载（未登录 401，穿越 404）
13. **文件编辑**：文件 agent（Claude Code headless）改文件 → 返回修改后 artifact
14. **ZIP 上传/解压**：上传 `.zip` 自动 `safeExtractZip` 解压到 input/（zip-slip / zip bomb / symlink 防护，全量校验通过才落盘）；**「修改后重打包 zip 下载」无确定性端点**（`safePackZip` 仅库层，未接 HTTP；见 §3 T09 与 §4）
15. **Workspace Manager**：input/output/task/artifacts/.go-ai 结构 + task spec（task.json/task.md）+ manifest + 安全边界（路径穿越拒绝）
16. **Sandbox Runtime Adapter**：GoFileAgentAdapter 代理 go-ai-file-agent:18082 + cc-auth-gateway:18081，事件归一化/超时/错误分类
17. **Agent Runner**：状态机 queued→creating_workspace→reading_files→…→done/failed，产物存在性校验后注册，partial 保留
18. **Job Event Stream**：NDJSON（status/tool/progress/artifact/result/error/done 序列化）
19. **Vision → MiniMax**：非视觉模型收到图片 → 服务端 MiniMax describe → 视觉描述上下文
20. **图片 + 文件 → Agent Workspace**：图片转视觉描述 + 上传文件入 workspace → agent 结合执行（参考图→改 HTML→artifact 已验证）
21. **Skills 注入**：聊天路由 + File Agent 双路透传（skill 物化进任务说明）
22. **Memory / personalization 初版**：localStorage，Memory/Style/Skills 独立注入（初版，见风险 §5.8）
23. **手机端可用性**：移动端布局（E2E TEST13 通过），核心流程可用
24. **主题黑白切换**：自动/浅色/深色（E2E TEST10 通过）
25. **Docker 重启恢复**：`--restart unless-stopped`，重启韧性已验证；数据在 bind mount 持久化

## 3. 用户验收矩阵

> 状态列：`已验证`（线上回归/单测/E2E 已覆盖，可复测）；`部分`（能力存在但有边界，见括号）；`需确认`（依赖真实模型/浏览器，用户复测为准）。

| 编号 | 能力 | 用户操作 | 预期结果 | 当前状态 | 用户确认 |
|---|---|---|---|---|---|
| T01 | 普通聊天 | 打开网页，选 GLM 5.2，输入「你好，用一句话介绍你现在能做什么。」 | 返回完整 final answer，不只 reasoning | 已验证 | ☐ |
| T02 | DeepSeek reasoning 回归 | 选 DeepSeek V4 Pro，输入经典旋转圆环物理题 | 有可折叠 reasoning；有 final answer；不出现只有思考无回复；不出现 Empty messages are not allowed；第二轮追问正常 | 已验证（E2E TEST1-3 + 真模型回归） | ☐ |
| T03 | PPTX Artifact | 输入「根据旋转圆环小珠问题，生成两页 PPT 文件。」 | 不输出「复制到 PowerPoint」；返回 .pptx 文件卡片；可下载；本地 PowerPoint/WPS 可打开 | 已验证（线上回归 pptx 7963B 下载） | ☐ |
| T04 | HTML Artifact | 输入「生成一个超过 150 行的 HTML 单文件网页。」 | 出现 HTML 文件卡片；可下载；浏览器可打开；正文不残留完整长代码 | 部分：确定性生成器产物约 30–40 行，**不保证 >150 行**（仅聊天内联超 100 行才文件化，E2E TEST6 覆盖） | ☐ |
| T05 | CSV Artifact | 输入「生成一个 5 行 3 列的 CSV 文件。」 | 返回 .csv；下载后内容正确；编码正常 | 部分：确定性生成器对自然语言输入产出**最小键值表（1 行 2 列）**；要得到 5×3 表须输入含逗号的行（如 `a,b,c↵1,2,3↵…`）。见 §4 边界说明 | ☐ |
| T06 | 上传 Markdown 修改 | 上传 .md，输入「把这个文档整理成结构清晰的版本，并返回修改后的文件。」 | 文件进入 workspace；agent 处理；返回修改后 .md artifact；原文件不丢失 | 已验证（文件 agent 闭环） | ☐ |
| T07 | 上传图片问答 | 上传截图，输入「你看到了什么？」 | 走 MiniMax Vision；返回图片内容描述；不进 File Agent | 已验证（glm+图片→MiniMax→回答） | ☐ |
| T08 | 图片 + 文件修改 | 上传截图 + HTML 文件，输入「按照截图风格修改这个 HTML。」 | 图片转视觉描述；文件入 workspace；agent 修改 HTML；返回修改后 HTML | 已验证（参考图→改背景色→artifact 闭环） | ☐ |
| T09 | ZIP 项目处理 | 上传含 index.html/style.css/script.js 的 zip，输入「把背景改成深色并重新打包。」 | 安全解压到 input/；agent 改文件；**重新打包 zip 下载当前无确定性端点**（依赖上游 agent 是否产出 zip）；无 zip-slip | 部分（解压+防护已验证；重打包未接线） | ☐ |
| T10 | 手机端 | 手机打开线上地址，登录后：普通聊天 / 上传图片 / 下载 artifact | 核心流程可用 | 已验证（E2E TEST13 布局 + API 回归）；浏览器差异见风险 §5.4 | ☐ |
| T11 | 文件下载认证 | 未登录直接访问 artifact 下载 URL | 返回 401 | 已验证 | ☐ |
| T12 | Artifact 过期 | 等待过期策略生效后访问旧 artifact | 返回 404（读取时强制过期） | 已验证（normalizeArtifact 单测） | ☐ |
| T13 | 刷新恢复 | 聊天后刷新页面 | 最近对话恢复，artifact 历史可见 | 已验证（E2E TEST7） | ☐ |
| T14 | 主题切换 | 设置里切 浅色/深色/自动 | 全局主题立即切换并持久化 | 已验证（E2E TEST10） | ☐ |
| T15 | Skills 导入 | 个性化里导入 SKILL.md 并开启，再聊天 | 该 skill 规则被注入 | 已验证（E2E TEST15 + skills→File Agent 回归） | ☐ |

## 4. 不可用 / 降级能力

- **Grok（grok-4.5）**：已下架，上游 503 Endpoint unavailable，不作为可用模型
- **GPT Luna（gpt-5.6-luna）**：保留研究；当前受区域限制（403 not available in your region），不计入可用核心能力
- **语音**：不做（用户已指示）
- **宠物**：不做
- **sandbox Bash**：不开放（文件 agent 容器 Bash deny，安全测试通过）
- **多用户权限系统**：无；仅单密码认证（ACCESS_PASSWORD + HttpOnly session）
- **ZIP 重打包下载**：`safePackZip` 库层存在但未接 HTTP 端点；上传 zip 自动安全解压已接线
- **确定性生成器边界**（T04/T05 相关）：不按自然语言生成「N 行 M 列表格」或「>150 行 HTML」；输入须含结构化数据（带逗号的行）才能得到表格

## 5. 已知风险

1. **DeepSeek V4 Pro reasoning-only 是否彻底修复**：防呆逻辑已实现（E2E TEST2：仅推理→重试提示→下一轮正常），但真实模型长回答仍需用户复测 T02
2. **GPT Luna 地区限制**：上游 403，中国大陆 IP 不可用，属上游策略非部署故障
3. **Grok 上游 503**：Endpoint 不可用，已下架；若上游恢复需重新验证
4. **手机端浏览器差异**：E2E 覆盖 Chrome 布局；Safari/微信内置浏览器/低端机未物理回归
5. **Artifact 过期策略**：读取时强制过期（normalizeArtifact）；过期 TTL 具体值需确认与用户预期一致
6. **Workspace 清理策略**：`cleanupExpired`/`cleanupWorkspace` 函数存在但**未接线自动调度**——过期 workspace 不会自动 GC，长期使用会累积磁盘
7. **ZIP 大文件边界**：`DEFAULT_LIMITS`（maxFiles/maxFileSize/maxTotalSize）有防护；超大 zip 依赖该限制拒绝，未做真实大文件压测
8. **Skills / Memory 为初版**：localStorage 存储，单浏览器本机；非服务端多端同步
9. **production 数据持久化边界**：workspaces/artifacts 在 bind mount（/opt/ai-client/data），容器重建不丢；但无备份/清理策略
10. **安全边界**：Bash deny / agent 容器不暴露 .env（claude 拒绝读）/ 不挂 Docker socket / 真实 key 仅存 cc-auth-gateway；均已验证，但需保持容器参数不被后续改动破坏

## 6. 回滚方案

- **当前镜像**：`f996db89ae4f`（ai-client:latest，2026-08-13）
- **上一稳定镜像**：`sha256:004496a07…`（2026-08-13 本轮部署前的旧镜像，已记录）
- **回滚命令**（保留 go-ai-net / unless-stopped / 2GB / env-file / data volume）：
  ```bash
  sudo docker rm -f ai-client
  sudo docker run -d --name ai-client \
    -p 127.0.0.1:3000:3000 \
    --restart unless-stopped \
    --env-file /opt/ai-client/.env \
    --log-opt max-size=10m --log-opt max-file=3 \
    --memory=2g \
    --network go-ai-net \
    -v /opt/ai-client/data:/data \
    sha256:004496a07…
  ```
- **回滚后验证项**：登录（401/200）→ 模型列表 7 个 → 生成器（pptx/html/csv 下载）→ 文件 agent 闭环（上传→任务→artifact）。可用回归脚本 `/tmp/ai-client-regression.py`
- **回滚不动基础设施**：sing-box / nginx / docker / go-ai-net 与 AI Client 生命周期完全分离（约束满足）

## 7. 用户验收结论区

- 用户确认通过：☐
- 用户发现问题：______________
- 必修问题：______________
- 可延后问题：______________
- 是否允许进入下一版本：☐ 是 / ☐ 否
