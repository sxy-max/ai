# AgentScope Runtime Adapter（V1.1 WP6）

## 定位
AgentScope 2.0 是 Go AI 后续核心 Agent Runtime 方向。本轮**不推翻**已验证的 Claude Code Runtime（ClaudeCodeRuntimeAdapter），而是并列实现 AgentScopeRuntimeAdapter，环境就绪时可无痛替换。

## 接口
`lib/sandbox/agentscopeRuntime.ts`：`AgentScopeRuntimeAdapter implements AgentRuntimeAdapter`
- prepare：AGENTSCOPE_URL 配置 + `/go-ai/health` 探测
- execute：createCredential(DeepSeek) → createAgent（执行指令含 workspace 流程契约）→ createSession → setPermissionBypass → streamEvents（SSE 先连后触发）→ triggerRun → 事件映射（tool_start/tool_result/text/candidate_complete/error → SandboxRunEvent）
- collectOutputs：共享卷 output//artifacts/（与 ClaudeCodeRuntimeAdapter 一致）
- cancel/cleanup：上层 AbortController

## 映射
| AgentScope WorkbenchEvent | SandboxRunEvent |
|---|---|
| tool_start | tool {name} |
| tool_result | tool {name, detail: output} |
| text | text |
| candidate_complete | done (exitCode 0) |
| error | error |

## workspace 契约
与 ClaudeCodeRuntimeAdapter 相同：`WORKSPACES_ROOT/tasks/{taskId}/`，task.md 流程（input 只读 → working 修改 → output 交付）。

## 部署前置（环境）
- `AGENTSCOPE_URL`（AgentScope 服务地址，compose 内 agent-runtime:8000）
- DeepSeek key（复用 OPENCODE_GO_API_KEY 通道）
- services/agent-runtime（compose 构建；线上尚未部署，V1.1 候选）

## 切换方式
devExecutor 的 adapter 注入点（deps.adapter）传 AgentScopeRuntimeAdapter 即可；业务（worker/executor）无感知。
