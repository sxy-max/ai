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

## 服务器（真实模型通道，WP33 云端执行完成）

部署：ai-client:v1.2（web+worker）+ AgentScope 生产栈（agent-runtime + sandbox-daemon；AGENTSCOPE_SANDBOX=local 模式，Docker 沙盒已就绪待工具兼容验证）

| 任务 | ClaudeCodeRuntime | AgentScopeRuntime |
|------|-------------------|-------------------|
| MD 修改 | ✅ E2（note v1 产物） | ✅ AS-MD（note v1，真实 kimi-k3） |
| CSV 修改 | ✅ E3（去重排序内容验证） | — |
| HTML 修改 | ✅ E6（index v1） | ✅ AS-IMG-HTML（index v1，含 vision） |
| ZIP 多文件 | ✅ E7（site v2） | — |
| 图片+HTML | ✅ E6 | ✅ AS-IMG-HTML（WP13 云端复测 PASS） |
| PPTX | ✅ E4（60856 bytes 合法容器） | —（deterministic） |
| continuation | ✅ E9（v2 版本化） | — |
| artifact 下载 | ✅ E10 | — |

关键配置（云端）：AGENTSCOPE_MODEL=kimi-k3（工具调用能力强；deepseek-v4-pro 推理模型在 AgentScope 工具循环不调工具——记录）、AGENTSCOPE_BASE_URL=opencode 通道、FORCE_AGENTSCOPE 验收开关（生产默认 claude-code 优先）、预算 tool_loop（每 step 2048）。

## 初版 RuntimePolicy 结论（本地+云端数据）

- 简单文件任务（MD/CSV）：两个 runtime 都适用；AgentScope 本地闭环 300-400ms（mock 模型下）。
- 图片+HTML：需要 vision 预处理（与 runtime 无关，devExecutor 层）；AgentScope 支持（工具循环 Read/Write）。
- 文件工具契约一致：两 runtime 均暴露 Read/Write/Edit/Glob/Grep/Bash 同构工具（Claude Code 原生；AgentScope 内置）。
- 路由规则（ExecutionPolicyEngine）：zip/图片任务 claude-code 首选、agentscope fallback；纯文件任务同样。
  服务器真实数据出来后再调权重。
