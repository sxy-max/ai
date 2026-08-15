# V12 Security & Acceptance（2026-08-15，V1.2 WP29-30）

## WP29 安全回归

### V1.1 安全边界（workspace/safety.ts）回归
workspace 隔离、symlink 逃逸、限额（文件大小/数量）、路径穿越、ZIP Slip、agent timeout、
跨 workspace 隔离——V1.1 测试全部保留且继续通过（tests 343+）。

### AgentScope Runtime 引入后的边界验证（真实 server 探测）

| 探测 | 结果 | 结论 |
|------|------|------|
| `/workspace/files?path=../../outside` | 404（拒绝） | 读逃逸被拒 ✓ |
| `/workspace/files?path=..\..\..\Windows\win.ini` | 404（拒绝） | 反斜杠逃逸被拒 ✓ |
| `/workspace/files?path=input/../input/note.md` | 404 | 规范化后拒绝 ✓ |
| `/workspace/directories?path=../../..` | **200，泄漏宿主目录结构** | **缺口（upstream）** |

### 缺口与缓解（记录，不绕过）
- **缺口**：AgentScope 2.0.6 的 `GET /workspace/directories` 未把 path 限制在 agent workdir 内，
  可枚举宿主目录（只读信息泄漏；写/读文件端点均被拒）。
- **缓解**：
  1. **生产部署使用 DockerBackend**（agentscope 原生容器隔离）：枚举只在容器内可见，逃逸无效
     ——Cloud Candidate 的 agent-runtime 容器内运行即满足；
  2. adapter system_prompt 明确"只访问工作区内路径"（本地验收环境）；
  3. 上游缺口已记录（升级 agentscope 时复核）。
- **V1.1 边界未被破坏**：devExecutor 的 workspace 同步（syncToAgentWorkspace/syncBackOutputs）
  均有 `startsWith(agentRoot)` 路径守卫；任务 workspace 布局不变。

## WP30 V1.2 验收矩阵

标注：U=unit，I=integration（mock/本地链），LR=local real（本地真实运行时），CR=cloud real（云端，WP33）。

| # | 验收项 | U | I | LR | CR | 说明 |
|---|--------|---|---|----|----|------|
| T01 | 普通 chat | ✓ | ✓ | ✓ | 待 | E2E mock + 真实模型（T7 验证） |
| T02 | deepseek-v4-pro 高难 reasoning | ✓ | ✓ | ✓ | 待 | 截断/重试真实验证 |
| T03 | reasoning 低预算自动升级 | ✓ | ✓ | ✓ | 待 | WP14+BudgetManager 档位升级 |
| T04 | MD 修改 | ✓ | ✓ | ✓ | 待 | dev executor + AgentScope A-MD |
| T05 | CSV 去重排序 | ✓ | ✓ | ✓ | 待 | B-CSV 334ms |
| T06 | XLSX | ✓ | ✓ | — | 待 | xlsxReader + generator |
| T07 | 图片问答 | ✓ | ✓ | ✓ | 待 | vision+chat（integration mock） |
| T08 | 图片+HTML 修改 | ✓ | ✓ | ✓ | 待 | C-IMG-HTML 26.6s + VISION_VERIFY |
| T09 | ZIP 项目修改 | ✓ | ✓ | — | 待 | 服务器（本地无 file-agent） |
| T10 | PPTX 两页 | ✓ | ✓ | ✓ | 待 | theme 渲染测试（真实 pptx buffer） |
| T11 | 无 Artifact → repair | ✓ | ✓ | ✓ | 待 | dev-executor 修复循环测试 |
| T12 | invalid Artifact → repair | ✓ | ✓ | — | 待 | validator + repair policy |
| T13 | AgentScope MD task | ✓ | — | ✓ | 待 | A-MD 385ms |
| T14 | AgentScope CSV task | ✓ | — | ✓ | 待 | B-CSV 334ms |
| T15 | AgentScope HTML task | ✓ | — | ✓ | 待 | C-IMG-HTML |
| T16 | Claude Code HTML task | ✓ | — | — | 待 | 需 file-agent 容器 |
| T17 | runtime fallback | ✓ | ✓ | — | 待 | ExecutionPolicy runtime 降级测试 |
| T18 | provider unavailable | ✓ | — | ✓ | 待 | probe（Luna 本地 available/Grok 503） |
| T19 | worker restart recovery | ✓ | ✓ | — | 待 | V1.1 崩溃恢复测试 |
| T20 | continuation task | ✓ | ✓ | ✓ | 待 | T10 二轮修改 11→22 + lineage 测试 |
| T21 | Project Workspace continuation | ✓ | ✓ | — | 待 | project 上下文测试 |
| T22 | Skills injection | ✓ | ✓ | — | 待 | dev skills 注入测试 |
| T23 | artifact versioning | ✓ | ✓ | — | 待 | v1/v2 测试 |
| T24 | cleanup / retention | ✓ | ✓ | — | 待 | workspace cleanup 测试（V1.1） |
| T25 | security traversal | ✓ | ✓ | ✓ | 待 | V1.1 安全测试 + AgentScope 边界探测 |
