# V13 DeepSeek Tool Calling Protocol（2026-08-15，V1.3 WP8）

## 结论先行

**模型协议层无兼容问题**。三模型（deepseek-v4-flash / deepseek-v4-pro / kimi-k3）在
opencode 通道下都正确产生 OpenAI 风格 `tool_calls`；V1.2 观察到的 "pro 不调工具 / Docker 工具不兼容"
**根因是 sandbox-daemon（dind）初始化竞态**：首次启动时 DockerWorkspace 初始化失败 →
AgentScope agent 启动即报 upstream/setup error → 所有模型都"不工作"；
当时 kimi-k3 恰好在 local 沙盒验证通过，被误判为"pro 不支持工具"。

## Probe 方法

直接调用 opencode `/chat/completions`（模拟 AgentScope DeepSeekChatModel 的请求格式：
`tools`（echo）+ `tool_choice: auto`），stream 与 non-stream 各一次，抓取
finish_reason / tool_calls / reasoning_content / content。

## Probe 结果（同一 echo schema）

| 模型 | stream | status | finish_reason | tool_calls | reasoning |
|------|--------|--------|---------------|------------|-----------|
| deepseek-v4-flash | false | 200 | tool_calls | echo{text:hello} ✓ | 69 字符 |
| deepseek-v4-flash | true | 200 | tool_calls | echo ✓ | 71 字符 |
| deepseek-v4-pro | false | 200 | tool_calls | echo ✓ | 129 字符 |
| deepseek-v4-pro | true | 200 | tool_calls | echo ✓ | 66 字符 |
| kimi-k3 | false | 200 | tool_calls | echo ✓ | 171 字符 |
| kimi-k3 | true | 200 | tool_calls | echo ✓ | 90 字符 |

## 七问回答

- A. 模型是否真的产生 tool call？**是**（三模型全部，含 deepseek-v4-pro）
- B. Provider 返回什么格式？**OpenAI 风格 tool_calls**（function{name,arguments}），reasoning_content 独立字段
- C. 是否兼容 OpenAI tool_calls？**是**（stream 与 non-stream 均正常；参数 JSON 字符串）
- D. 是否返回 reasoning_content 与 content 混合？**是**（推理模型有 reasoning_content；工具调用在 tool_calls 字段——AgentScope DeepSeekChatModel 已处理该结构，实测通过）
- E. AgentScope parser 是否丢字段？**无证据**（库级 reply_stream 完整收到 TOOL_CALL_START/DELTA/END）
- F. schema 是否触发模型拒绝？**否**（简单 function schema 三模型都接受）
- G. stream 与 non-stream 是否不同？**无协议差异**（均 tool_calls）

## V1.2 遗留问题根因确认

| V1.2 现象 | 根因 | 当前状态 |
|-----------|------|---------|
| AgentScope Docker 沙盒工具不兼容（upstream error） | sandbox-daemon（dind）初始化竞态；DockerWorkspace 初始化失败 → agent 启动失败 | ✅ dind 稳定后 Docker 沙盒工具任务全通（AS-MD/AS-IMG-HTML，pro 与 kimi 均验证） |
| deepseek-v4-pro 在 tool loop 不调工具 | 同上（当时环境所有模型都失败；kimi 恰在 local 沙盒通过） | ✅ pro 在 Docker 沙盒云端真实任务全通（note v3 / index v3） |

## ToolCallAdapter（WP9）结论

- **无需 provider 特定协议补丁**：opencode 通道（AgentScope credential base_url）已提供
  标准 OpenAI tool_calls；归一化层由 RuntimeToolProtocol（WP7：ToolCall/ToolResult/ToolError +
  sandboxManagerExecutor）承担。
- **架构建议保留**：Reasoning Model ≠ Execution Model（复杂任务 pro 规划 → 执行模型跑工具循环）
  ——WP10 落地为 plannerModel/executorModel。
