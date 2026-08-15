/**
 * V1.5 Phase A mock：OpenAI 兼容 chat completions（确定性 agent 行为）。
 * 第一轮（无 tool 结果）：返回 Write 工具调用（写 output/note.md）
 * 有 tool 结果后：返回完成文本。
 * 用于本地验证 AgentScope loop/工具/workspace/SSE 全链（真实模型放服务器验收）。
 */
import http from "node:http";

const server = http.createServer((req, res) => {
  if (req.method === "POST" && (req.url || "").includes("/chat/completions")) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const messages = body.messages || [];
      console.log("[mock] req messages:", JSON.stringify(messages.map((m) => ({ role: m.role, tool_calls: !!m.tool_calls, content: typeof m.content === "string" ? m.content.slice(0, 60) : "list" }))));
      // 检测是否已有工具结果（assistant 带 tool_calls 或 role=tool 消息）
      const hasToolTurn = messages.some((m) => m.role === "tool" || (m.role === "assistant" && m.tool_calls));
      const model = body.model || "mock";
      let payload;
      if (!hasToolTurn) {
        // 第一轮：要求调用 Write 工具（与 AgentScope 内置工具 schema 匹配）
        payload = {
          id: "mock-1", object: "chat.completion", created: 1, model,
          choices: [{
            index: 0, finish_reason: "tool_calls",
            message: {
              role: "assistant", content: null,
              tool_calls: [{
                id: "call_mock_1", type: "function",
                function: {
                  name: "Write",
                  arguments: JSON.stringify({ file_path: "output/note.md", content: "# 拉格朗日量简介\n\n拉格朗日量 L = T − V，通过最小作用量原理导出运动方程。\n" }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      } else {
        // 工具执行完成：返回最终文本
        payload = {
          id: "mock-2", object: "chat.completion", created: 2, model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "已完成：文件已写入 output/note.md。" } }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});

server.listen(8095, "127.0.0.1", () => console.log("mock openai on 8095"));
