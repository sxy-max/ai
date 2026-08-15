# V12 Runtime Benchmark（2026-08-15，V1.2 WP9）

双 Runtime 对照：相同任务分别在 AgentScope / Claude Code 上执行。
方法：同一 dev 步骤（runDevStep）经 ExecutionPolicy 选 runtime；任务相同；记录执行指标。
只比较任务执行结果，不做"谁模型强"主观评价。

## 本地（AgentScope 真实运行时，mock LLM 通道）

前置：`scripts/agentscope-server.py`（端口 18010，WORKSPACES_ROOT=D:\Projects\go-ai\.data\agentscope-ws）
+ `scripts/llm-mock-server.mjs`（端口 18020，OpenAI 兼容 mock，驱动 agent 的 Read→Write→final 工具循环）
运行：`npx tsx scripts/agentscope-real-acceptance.ts`

| 任务 | 耗时 | 产物 | 事件链 | 说明 |
|------|------|------|--------|------|
| A-MD 结构化文章 | 385ms | article.md（markdown v1） | agent.started → tool(Read/Write) → artifact.created → agent.completed | agent 真实读 input/note.md、写 output/article.md |
| B-CSV 去重排序 | 334ms | data.csv（csv v1） | 同上 | 真实读取 CSV、写回 output/ |
| C 图片+HTML 重做 | 26.6s | index.html（html v1） | vision 预处理（真实 MiniMax）→ agent 修改 | 含 vision 扫描耗时；agent 侧 3 步工具循环 |

所有任务：产物注册 PG（版本化）、runtime.json.adapterId=agentscope（ExecutionPolicy 正确路由）、
事件经统一 AgentEvent 进 task_events。

## 服务器（真实模型通道，WP33 云端执行）

待云端部署后补齐（ClaudeCodeRuntime 需 go-ai-file-agent 容器；AgentScope 用真实 deepseek credential）：

| 任务 | ClaudeCodeRuntime | AgentScopeRuntime |
|------|-------------------|-------------------|
| MD 修改 | 待测 | 待测 |
| CSV 修改 | 待测 | 待测 |
| HTML 修改 | 待测 | 待测 |
| ZIP 多文件 | 待测 | 待测 |
| 图片+HTML | 待测 | 待测 |

记录字段：time、attempts、tool calls、artifact validity、token usage、失败模式。

## 初版 RuntimePolicy 结论（本地数据）

- 简单文件任务（MD/CSV）：两个 runtime 都适用；AgentScope 本地闭环 300-400ms（mock 模型下）。
- 图片+HTML：需要 vision 预处理（与 runtime 无关，devExecutor 层）；AgentScope 支持（工具循环 Read/Write）。
- 文件工具契约一致：两 runtime 均暴露 Read/Write/Edit/Glob/Grep/Bash 同构工具（Claude Code 原生；AgentScope 内置）。
- 路由规则（ExecutionPolicyEngine）：zip/图片任务 claude-code 首选、agentscope fallback；纯文件任务同样。
  服务器真实数据出来后再调权重。
