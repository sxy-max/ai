/**
 * mcp-lite：MCP stdio server 轻量骨架（JSON-RPC 2.0 over stdio）。
 * 协议：initialize → notifications/initialized → tools/list → tools/call。
 * 避免引入 @modelcontextprotocol/sdk 依赖，保持容器最小。
 */

import readline from "node:readline";

export function createMcpServer({ name, version, tools }) {
  const rl = readline.createInterface({ input: process.stdin });
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try { req = JSON.parse(trimmed); } catch { return; }
    if (req.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: req.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name, version },
        },
      });
      return;
    }
    if (req.method === "notifications/initialized") return;
    if (req.method === "tools/list") {
      send({ jsonrpc: "2.0", id: req.id, result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } });
      return;
    }
    if (req.method === "tools/call") {
      const tool = tools.find((t) => t.name === req.params?.name);
      if (!tool) {
        send({ jsonrpc: "2.0", id: req.id, error: { code: -32602, message: `unknown tool: ${req.params?.name}` } });
        return;
      }
      try {
        const result = await tool.handler(req.params?.arguments || {});
        send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
      } catch (err) {
        send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } });
      }
      return;
    }
    // 未识别方法：MCP 客户端容忍空响应（避免 stdout 污染）
  });
}
