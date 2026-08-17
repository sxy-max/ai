import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.GATEWAY_PORT || 18081);
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function writeSse(res, event, body) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
}

function anthropicError(res, status, message) {
  const type = status === 401 || status === 403 ? "authentication_error" : "api_error";
  writeJson(res, status, { type: "error", error: { type, message } });
}

async function readRequest(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text || ""))
    .join("\n");
}

function deepSeekMessages(input) {
  const messages = [];
  const system = textFromContent(input.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of input.messages || []) {
    const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    const text = textFromContent(blocks);
    const toolCalls = blocks
      .filter((block) => block?.type === "tool_use")
      .map((block) => ({
        id: String(block.id || `call_${crypto.randomUUID().replace(/-/g, "")}`),
        type: "function",
        function: { name: String(block.name || "tool"), arguments: JSON.stringify(block.input || {}) },
      }));
    const toolResults = blocks.filter((block) => block?.type === "tool_result");

    if (message.role === "assistant") {
      if (text || toolCalls.length) {
        messages.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      }
      continue;
    }

    if (text) messages.push({ role: "user", content: text });
    for (const result of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: String(result.tool_use_id || ""),
        content: textFromContent(result.content) || "(no tool output)",
      });
    }
    if (!text && !toolResults.length) messages.push({ role: "user", content: "(empty user message)" });
  }
  return messages;
}

function deepSeekTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: String(tool.name || "tool"),
      description: String(tool.description || ""),
      parameters: tool.input_schema && typeof tool.input_schema === "object" ? tool.input_schema : { type: "object", properties: {} },
    },
  }));
}

function messageStart(model) {
  return {
    type: "message_start",
    message: {
      id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}

function finishReason(reason) {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

function anthropicMessage(model, choice, usage) {
  const message = choice?.message || {};
  const content = [];
  if (message.content) content.push({ type: "text", text: String(message.content) });
  for (const toolCall of message.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(toolCall.function?.arguments || "{}"); } catch {}
    content.push({ type: "tool_use", id: String(toolCall.id || "call_unknown"), name: String(toolCall.function?.name || "tool"), input });
  }
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: finishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: Number(usage?.prompt_tokens || 0), output_tokens: Number(usage?.completion_tokens || 0) },
  };
}

async function streamToAnthropic(upstream, res, model, signal) {
  writeSse(res, "message_start", messageStart(model));
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  let buffer = "";
  let textIndex = -1;
  let nextIndex = 0;
  let stopReason = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0 };
  const tools = new Map();

  const startText = () => {
    if (textIndex >= 0) return;
    textIndex = nextIndex++;
    writeSse(res, "content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } });
  };
  const startTool = (index, call) => {
    let state = tools.get(index);
    if (state) return state;
    state = {
      blockIndex: nextIndex++,
      id: String(call.id || `call_${crypto.randomUUID().replace(/-/g, "")}`),
      name: String(call.function?.name || "tool"),
    };
    tools.set(index, state);
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index: state.blockIndex,
      content_block: { type: "tool_use", id: state.id, name: state.name, input: {} },
    });
    return state;
  };
  const consume = (raw) => {
    if (!raw || raw === "[DONE]") return;
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    const choice = payload.choices?.[0];
    const delta = choice?.delta || {};
    if (typeof delta.content === "string" && delta.content) {
      startText();
      writeSse(res, "content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: delta.content } });
    }
    for (const call of delta.tool_calls || []) {
      const state = startTool(Number(call.index || 0), call);
      if (typeof call.function?.arguments === "string" && call.function.arguments) {
        writeSse(res, "content_block_delta", { type: "content_block_delta", index: state.blockIndex, delta: { type: "input_json_delta", partial_json: call.function.arguments } });
      }
    }
    if (choice?.finish_reason) stopReason = finishReason(choice.finish_reason);
    if (payload.usage) usage = { input_tokens: Number(payload.usage.prompt_tokens || 0), output_tokens: Number(payload.usage.completion_tokens || 0) };
  };

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || "";
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        consume(data);
      }
    }
    if (buffer.trim()) {
      const data = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      consume(data);
    }
  } finally {
    if (textIndex >= 0) writeSse(res, "content_block_stop", { type: "content_block_stop", index: textIndex });
    for (const state of tools.values()) writeSse(res, "content_block_stop", { type: "content_block_stop", index: state.blockIndex });
    writeSse(res, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage });
    writeSse(res, "message_stop", { type: "message_stop" });
    res.end();
  }
}

async function handleMessages(req, res) {
  if (!API_KEY) return anthropicError(res, 503, "DeepSeek API key is not configured");
  let input;
  try { input = await readRequest(req); } catch { return anthropicError(res, 400, "Invalid JSON request"); }
  const model = typeof input.model === "string" && /^deepseek-v4-(flash|pro)$/.test(input.model) ? input.model : DEFAULT_MODEL;
  const payload = {
    model,
    messages: deepSeekMessages(input),
    max_tokens: Math.max(1, Math.min(Number(input.max_tokens) || 1024, 8192)),
    stream: input.stream !== false,
    ...(deepSeekTools(input.tools) ? { tools: deepSeekTools(input.tools) } : {}),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
  };
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  let upstream;
  try {
    upstream = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
    });
  } catch {
    return anthropicError(res, 502, "DeepSeek provider connection failed");
  }
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.json().catch(() => null);
    return anthropicError(res, upstream.status || 502, String(detail?.error?.message || "DeepSeek provider request failed").slice(0, 300));
  }
  if (input.stream === false) {
    const body = await upstream.json();
    return writeJson(res, 200, anthropicMessage(model, body.choices?.[0], body.usage));
  }
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  return streamToAnthropic(upstream, res, model, abort.signal);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return writeJson(res, 200, { ok: true, provider: "deepseek", model: DEFAULT_MODEL });
  if (req.method === "POST" && req.url?.startsWith("/v1/messages")) return void handleMessages(req, res);
  return writeJson(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => console.log(`cc-auth-gateway deepseek on :${PORT}`));
