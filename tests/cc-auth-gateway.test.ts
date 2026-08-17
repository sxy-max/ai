import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No TCP address"));
      resolve(address.port);
    });
  });
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No TCP address"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForHealth(port: number) {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw lastError || new Error("Gateway did not become healthy");
}

test("cc-auth-gateway translates Anthropic tool streaming to DeepSeek", async (t) => {
  let received: Record<string, unknown> | null = null;
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = JSON.parse(body) as Record<string, unknown>;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "record_check", arguments: '{"topic":' } }] } }]
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"protocol"}' } }] } }]
    })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
  });
  const upstreamPort = await listen(upstream);
  const gatewayPort = await availablePort();
  const gateway = spawn(process.execPath, [path.join(process.cwd(), "services", "cc-auth-gateway", "gateway.mjs")], {
    env: {
      ...process.env,
      GATEWAY_PORT: String(gatewayPort),
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_MODEL: "deepseek-v4-flash"
    },
    stdio: "ignore"
  });

  t.after(async () => {
    if (gateway.exitCode === null) {
      gateway.kill("SIGTERM");
      await once(gateway, "exit");
    }
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  });

  await waitForHealth(gatewayPort);
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      max_tokens: 64,
      stream: true,
      system: "Follow the tool contract.",
      messages: [{ role: "user", content: "Record this check." }],
      tools: [{
        name: "record_check",
        description: "Record a protocol check.",
        input_schema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] }
      }]
    })
  });
  const events = await response.text();
  const delivered = received as Record<string, unknown> | null;

  assert.equal(response.status, 200);
  assert.ok(delivered, "Expected DeepSeek upstream request");
  assert.deepEqual(delivered.messages, [
    { role: "system", content: "Follow the tool contract." },
    { role: "user", content: "Record this check." }
  ]);
  assert.deepEqual(delivered.tools, [{
    type: "function",
    function: {
      name: "record_check",
      description: "Record a protocol check.",
      parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] }
    }
  }]);
  assert.match(events, /event: content_block_start[\s\S]*"type":"tool_use"/);
  assert.match(events, /event: content_block_delta[\s\S]*"partial_json":"\{\\"topic\\":"/);
  assert.match(events, /event: message_delta[\s\S]*"stop_reason":"tool_use"/);
});
