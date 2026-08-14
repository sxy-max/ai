import assert from "node:assert/strict";
import test from "node:test";
import { createAgentScopeClient } from "../../lib/agentscope/client";

test("client pins trusted user header and exact trigger route", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createAgentScopeClient({
    baseUrl: "http://runtime:8000/",
    userId: "owner",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ status: "started", session_id: "s1" });
    }
  });
  await client.triggerRun({ agent_id: "a1", session_id: "s1", input: {} });
  assert.equal(calls[0].url, "http://runtime:8000/chat/");
  assert.equal(new Headers(calls[0].init?.headers).get("X-User-ID"), "owner");
});

test("SSE handles chunk boundaries, keepalives and multiline data", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    ": keepalive\r\n\r\ndata: {\"type\":\"TEXT_BLOCK_",
    "DELTA\",\r\ndata: \"delta\":\"hi\"}\r\n\r\n",
    "data: {\"type\":\"REPLY_END\",\"finished_reason\":\"completed\",\"error\":null}\n\n"
  ];
  const client = createAgentScopeClient({
    baseUrl: "http://runtime",
    userId: "owner",
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); }
    }), { headers: { "Content-Type": "text/event-stream" } })
  });
  const events = [];
  for await (const event of client.streamEvents("a1", "s1")) events.push(event);
  assert.deepEqual(events, [{ kind: "status", status: "running" }, { kind: "text", text: "hi" }, { kind: "candidate_complete" }]);
});

test("bad JSON is an error event, not a thrown parser failure", async () => {
  const client = createAgentScopeClient({
    baseUrl: "http://runtime",
    userId: "owner",
    fetchImpl: async () => new Response("data: not-json\n\n", { headers: { "Content-Type": "text/event-stream" } })
  });
  const events = [];
  for await (const event of client.streamEvents("a", "s")) events.push(event);
  assert.equal(events[0]?.kind, "status");
  assert.equal(events[1]?.kind, "error");
});
