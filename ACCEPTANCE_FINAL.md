# Go AI — Final Convergence Acceptance（2026-08-17 定稿）

> 本 Goal 完成验收：Cloud AI Work System 最终架构（Claude Code 唯一主 Harness + Preflight 决策层）
> 的真实系统验收，**生产版本 ai-client:v2.4 + go-ai-file-agent:claude-v20**。
> 唯一架构真相：`CURRENT_EXECUTION_ARCHITECTURE.md`。

## 最终系统架构（一句话）

用户输入问题/文件/图片/项目 → **Preflight** 编译 Execution Directive（WHAT+CONSTRAINT+CAPABILITY，
无 HOW）→ 控制面（PG/Redis/worker 租约队列）→ **Claude Code**（go-ai-file-agent 容器，隔离工作区，
自动选择主模型，自主规划执行，经 MCP 调用 MiniMax 视觉 / Browser / Office / Search）→ **Go AI
Validation**（契约+格式+视觉，不合格证据回交同工作区修复）→ Artifact / Final Answer → Display。

## 主执行链

```
User Input (goal + files + images + project)
  → Preflight（lib/preflight/：规则确定性优先 → 能力/契约/主模型 Auto/MCP/工具/Workspace/Skills+Memory）
  → Execution Directive
  → 控制面（/api/tasks → PG/Redis → worker 租约/恢复/取消）
  → ClaudeCodeExecutor（唯一智能执行体 = go-ai-file-agent 容器，唯一主 Harness）
      · 主模型 Auto：capability → APPROVED_POOL 硬过滤（deepseek-v4-flash/pro）→ health → quota
      · MiniMax Vision Specialist（仅经 vision-mcp，UNTRUSTED 数据）
      · Browser / Office / Search 均为 Claude Code 的工具箱
  → Go AI Validation（格式/页数/数量/文件变化/视觉；失败 → 证据回交同工作区修复，有界轮数）
  → Artifact（PG 版本化）/ Final Answer → Display Layer
普通问答统一经同一条链（/api/chat → 容器 /chat 轻量 profile；生产无裸模型直连通道）
```

## 验收矩阵（本 Goal §43 能力组合，2026-08-17 云端真实执行，12/12 PASS）

| 场景 | 验证 | 结果 |
|---|---|---|
| 普通问答 | C01：/api/chat 经 Claude Code（flash）真实回答 196 字符 | ✅ PASS |
| 代码 | C02：真实 .py + 运行 | ✅ PASS |
| PPTX | C03：真实 .pptx + 2 页契约（56156B） | ✅ PASS |
| XLSX | C04：CSV → 真实 .xlsx | ✅ PASS |
| DOCX | C05：真实 .docx | ✅ PASS |
| PDF | C06：真实 .pdf（%PDF 头） | ✅ PASS |
| 图片问答 | C07：vision-mcp → MiniMax → 回答含视觉描述（514 字符） | ✅ PASS |
| 综合任务（§44） | C08：网站+参考图+CSV+需求 → 重构+视觉+修复+zip 102KB（含验证-修复闭环：第 1 轮缺产物 → 证据回交 → 第 2 轮修复交付） | ✅ PASS |
| 项目延续 | C09：同 project 两轮共享 workspace（文件树 20 项） | ✅ PASS |
| Cancel | C10：真实终止（状态 cancelled） | ✅ PASS |
| 并发 | C11：3 任务不串扰 | ✅ PASS |
| 移动端 | C12：390px 无横向滚动（/、/tasks、/projects） | ✅ PASS |
| **Cancel 进程级** | 深检查：cancel 前 file-agent 内 claude 进程=1 → cancel 后=0（断连 SIGKILL 生效） | ✅ PASS |
| **Recovery** | worker+file-agent 双杀 → 租约过期 → 孤儿回收（error=「任务在上一轮执行中被中断，已重新入队」）→ 续跑 completed | ✅ PASS |
| Harness Benchmark | B01-B05 × deepseek-v4-flash / pro（flash 5/5；pro 推理 65s 快于 flash；B01 系统缺陷已修复复测 PASS） | 见 docs/HARNESS_BENCHMARK.md |
| **Web Research** | 真实研究任务：search-mcp（Exa）+ browser-mcp（真实导航）→ 6360B markdown 交付 | ✅ PASS |

## 本收尾轮修复（commit 74db292 / a1e88b4）

- **Cancel 真终止**：AbortSignal 透传 adapter → fetch abort；file-agent 断连立即 SIGKILL claude
  （此前取消只改状态、claude 幽灵执行到 15 分钟超时）
- **Job 租约恢复循环收敛**（生产实测 18 job × 80 次/2h 无限循环）：claimExpiredJob 只认领每任务
  最新 job；recoverOrphanedTasks 按任务状态收敛 job 终态；认领列表移除 recovering
- **普通问答强制 Claude Code**：CHAT_LEGACY_DIRECT=1 才保留裸模型直连流（仅开发测试；生产无此变量）
- **模型池硬过滤**：APPROVED_POOL=[flash, pro]；probe 列表对齐；AGENTSCOPE 残留分支移除

## 本地验证（2026-08-17）

- typecheck ✓ / 单测 449/449 ✓ / build ✓ / E2E 17/17 ✓

## 生产部署（tencent-ai，2026-08-17）

- `ai-client:v2.4`（web+worker：Cancel 真终止 + Job 恢复收敛 + quick 模式 final answer 三层修复 + 附件图片 kind 兜底 + maxTurns 分档）+ `go-ai-file-agent:claude-v20`（含断连 kill）
- .env：CLAUDE_CHAT_ENABLED=1、FEATURED_MODELS=deepseek-v4-flash,deepseek-v4-pro,minimax-m3、
  AGENT_MODEL=deepseek-v4-flash（Auto 默认，bench 后恢复）
- 公网入口 http://122.51.78.4/ 已验证（nginx → 127.0.0.1:3000 → v2.4 web）
- 回滚点：ai-client:v1.8 / v2.0 / v2.1 / v2.2 / v2.3 镜像 + go-ai-file-agent:claude-v18/v19；/opt/ai-client-backup-v11
- git：origin/main @ 32037bd（收尾链 74db292→a1e88b4→49122ed→ea747ab→da4617f→506a56b→0c8f538→32037bd）

## 架构收敛（本 Goal 删除/旁路清单）

- **AgentScope 全栈删除**（净删 1785 行 + deploy/agentscope + 旧路由）：lib/agentscope、
  agentscopeRuntime、externalToolExecutor、jobStore、services/agent-runtime、v15/mock 脚本与测试、
  app/api/agent/task、app/api/files/upload、聊天内嵌文件任务链（runFileTask）
- **模型池收敛**：Auto 主链 DeepSeek 系（flash 高频 / pro 推理）；MiniMax 仅 Vision Specialist；
  kimi/qwen/glm 移出池且 APPROVED_POOL 硬过滤；grok disabled；luna region-gated
- **file-agent 权限**：/task bypassPermissions（容器隔离内全权限：非 root、仅 workspace、
  无 docker/socket/真实 key——Bash 是真实工作必需）
- **zip 兜底交付**：契约 kind=zip 时系统打包 deliverable.zip（机械打包不改内容）
- 保留（控制面/产品层）：worker/租约/恢复、job、completion、artifacts、workspace、policy、
  vision、browser、generators、preview、notify、metrics、auth、personalization、skills、memory

## 已知外部限制（非本 Goal 欠债）

- gpt-5.6-luna 地区门控（上游 403）、grok-4.5 上游 503（均不影响主链）
- PPTX 缩略图需 LibreOffice（服务器未装；预览页显示页数+下载）
- Claude Code 长任务（综合类）5-15 分钟执行时间；worker 单实例串行
- 注册限流 5 次/小时（IP 级内存态；重启 web 清空）——验收脚本用固定账号 + 429 跳过
