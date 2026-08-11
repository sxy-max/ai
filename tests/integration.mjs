import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

const projectRoot = new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const goKey = "go-test-key-never-send-to-anthropic";
const anthropicKey = "anthropic-test-key-never-send-to-go";
const accessPassword = "integration-access-password";
const observations = {
  goHeaders: [],
  anthropicHeaders: [],
  goResponsePayloads: [],
  goChatPayloads: [],
  goMessagePayloads: [],
  anthropicPayloads: []
};

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sse(response, events) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  response.end();
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

const providerServer = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://provider.test");
  if (url.pathname.startsWith("/go/")) {
    observations.goHeaders.push(request.headers);
    assert.equal(request.headers.authorization, `Bearer ${goKey}`);
    assert.notEqual(request.headers["x-api-key"], anthropicKey);
  }
  if (url.pathname.startsWith("/anthropic/")) {
    observations.anthropicHeaders.push(request.headers);
    assert.equal(request.headers["x-api-key"], anthropicKey);
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    assert.equal(request.headers.authorization, undefined);
  }

  if (url.pathname === "/go/v1/models") return json(response, 200, { data: [
    { id: "gpt-5.6-luna", input_modalities: ["text", "image"] },
    { id: "grok-4.5", input_modalities: ["text"] },
    { id: "qwen3.8-max", input_modalities: ["text"] },
    { id: "deepseek-v4-pro", input_modalities: ["text"] }
  ] });
  if (url.pathname === "/anthropic/v1/models") return json(response, 200, {
    data: [{
      id: "claude-sonnet-5",
      display_name: "Claude Sonnet 5",
      max_input_tokens: 200000,
      max_tokens: 64000,
      capabilities: { thinking: { supported: true }, effort: { supported: true }, image_input: { supported: true } }
    }],
    has_more: false,
    last_id: "claude-sonnet-5"
  });
  if (url.pathname === "/go/v1/chat/completions") {
    assert.equal(request.headers["x-api-key"], undefined);
    const payload = JSON.parse(await requestBody(request));
    observations.goChatPayloads.push(payload);
    assert.equal(payload.model, "grok-4.5");
    return sse(response, [{
      type: "chat.completion.chunk",
      data: { choices: [{ delta: { content: "Grok works", reasoning_content: "Fast." }, finish_reason: "stop" }] }
    }]);
  }
  if (url.pathname === "/go/v1/messages") {
    assert.equal(request.headers["x-api-key"], goKey);
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    const payload = JSON.parse(await requestBody(request));
    observations.goMessagePayloads.push(payload);
    assert.equal(payload.model, "qwen3.8-max");
    return sse(response, [
      { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Qwen thinks." } } },
      { type: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Qwen works" } } },
      { type: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
      { type: "message_stop", data: { type: "message_stop" } }
    ]);
  }
  if (url.pathname === "/go/v1/responses") {
    assert.equal(request.headers["x-api-key"], undefined);
    const payload = JSON.parse(await requestBody(request));
    observations.goResponsePayloads.push(payload);
    assert.equal(payload.model, "gpt-5.6-luna");
    if (JSON.stringify(payload).includes("cause-response-failed")) {
      return sse(response, [{
        type: "response.failed",
        data: { type: "response.failed", response: { error: { code: "mock_failure", message: "Mock response failure" } } }
      }]);
    }
    if (JSON.stringify(payload).includes("cause-truncated-stream")) {
      return sse(response, [{
        type: "response.output_text.delta",
        data: { type: "response.output_text.delta", delta: "Partial output" }
      }]);
    }
    return sse(response, [
      { type: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "Go works" } },
      { type: "response.completed", data: { type: "response.completed", response: { status: "completed" } } }
    ]);
  }
  if (url.pathname === "/anthropic/v1/messages") {
    const payload = JSON.parse(await requestBody(request));
    observations.anthropicPayloads.push(payload);
    assert.equal(payload.model, "claude-sonnet-5");
    assert.equal("temperature" in payload, false);
    assert.deepEqual(payload.thinking, { type: "adaptive", display: "summarized" });
    const prompt = payload.messages?.at(-1)?.content?.find?.((part) => part.type === "text")?.text || "";
    if (prompt.includes("cause-error")) {
      return sse(response, [{ type: "error", data: { type: "error", error: { type: "overloaded_error", message: "Mock overload" } } }]);
    }
    return sse(response, [
      { type: "message_start", data: { type: "message_start", message: { content: [] } } },
      { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Think." } } },
      { type: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Claude works" } } },
      { type: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
      { type: "message_stop", data: { type: "message_stop" } }
    ]);
  }
  json(response, 404, { error: "not found" });
});

let nextProcess;
let providerPort;
let appPort;
let nextOutput = "";

async function waitForApp(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Next.js did not start in time.\n${nextOutput}`);
}

function parseNdjson(text) {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

try {
  providerPort = await freePort();
  appPort = await freePort();
  await new Promise((resolve, reject) => {
    providerServer.once("error", reject);
    providerServer.listen(providerPort, "127.0.0.1", resolve);
  });

  nextProcess = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(appPort)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      ACCESS_PASSWORD: accessPassword,
      OPENCODE_GO_API_KEY: goKey,
      OPENCODE_GO_BASE_URL: `http://127.0.0.1:${providerPort}/go/v1`,
      ANTHROPIC_API_KEY: anthropicKey,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${providerPort}/anthropic/v1`,
      ALLOW_OTHER_MODELS: "false",
      FEATURED_MODELS: "gpt-5.6-luna,grok-4.5,qwen3.8-max,anthropic/claude-sonnet-5",
      ANTHROPIC_FEATURED_MODELS: "",
      RATE_LIMIT_REQUESTS_PER_MINUTE: "100"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  nextProcess.stdout.on("data", (chunk) => { nextOutput += chunk; });
  nextProcess.stderr.on("data", (chunk) => { nextOutput += chunk; });
  await waitForApp(`http://127.0.0.1:${appPort}/`);

  const badLogin = await fetch(`http://127.0.0.1:${appPort}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "wrong-password" })
  });
  assert.equal(badLogin.status, 401);

  const login = await fetch(`http://127.0.0.1:${appPort}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: accessPassword })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("go_ai_session="));

  const modelResponse = await fetch(`http://127.0.0.1:${appPort}/api/models`, { headers: { cookie } });
  assert.equal(modelResponse.status, 200);
  const modelData = await modelResponse.json();
  const goModel = modelData.models.find((model) => model.key === "gpt-5.6-luna");
  const grokModel = modelData.models.find((model) => model.key === "grok-4.5");
  const qwenModel = modelData.models.find((model) => model.key === "qwen3.8-max");
  const claudeModel = modelData.models.find((model) => model.key === "anthropic/claude-sonnet-5");
  assert.ok(goModel?.modelToken);
  assert.ok(grokModel?.modelToken);
  assert.ok(qwenModel?.modelToken);
  assert.ok(claudeModel?.modelToken);
  assert.equal(modelData.models.some((model) => model.key === "deepseek-v4-pro"), false);

  const chat = async (model, content, attachments) => await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      provider: model.provider,
      model: model.id,
      modelToken: model.modelToken,
      messages: [{ role: "user", content, ...(attachments ? { attachments } : {}) }],
      options: { temperature: 0.7, maxOutputTokens: 1024, reasoningEffort: "auto" }
    })
  });

  const goChat = await chat(goModel, "hello go");
  assert.equal(goChat.status, 200);
  assert.equal(parseNdjson(await goChat.text()).filter((event) => event.type === "text").map((event) => event.value).join(""), "Go works");

  const grokChat = await chat(grokModel, "hello grok");
  assert.equal(grokChat.status, 200);
  const grokEvents = parseNdjson(await grokChat.text());
  assert.equal(grokEvents.filter((event) => event.type === "reasoning").map((event) => event.value).join(""), "Fast.");
  assert.equal(grokEvents.filter((event) => event.type === "text").map((event) => event.value).join(""), "Grok works");

  const qwenChat = await chat(qwenModel, "hello qwen");
  assert.equal(qwenChat.status, 200);
  const qwenEvents = parseNdjson(await qwenChat.text());
  assert.equal(qwenEvents.filter((event) => event.type === "reasoning").map((event) => event.value).join(""), "Qwen thinks.");
  assert.equal(qwenEvents.filter((event) => event.type === "text").map((event) => event.value).join(""), "Qwen works");

  const responseFailure = await chat(goModel, "cause-response-failed");
  assert.equal(responseFailure.status, 200);
  const responseFailureEvents = parseNdjson(await responseFailure.text());
  assert.equal(responseFailureEvents.find((event) => event.type === "error")?.value, "Mock response failure");

  const truncatedResponse = await chat(goModel, "cause-truncated-stream");
  assert.equal(truncatedResponse.status, 200);
  const truncatedEvents = parseNdjson(await truncatedResponse.text());
  assert.equal(truncatedEvents.find((event) => event.type === "error")?.value, "Provider stream ended before a completion event");

  const claudeChat = await chat(claudeModel, "hello claude");
  assert.equal(claudeChat.status, 200);
  const claudeEvents = parseNdjson(await claudeChat.text());
  assert.equal(claudeEvents.filter((event) => event.type === "reasoning").map((event) => event.value).join(""), "Think.");
  assert.equal(claudeEvents.filter((event) => event.type === "text").map((event) => event.value).join(""), "Claude works");

  const streamError = await chat(claudeModel, "cause-error");
  assert.equal(streamError.status, 200);
  const errorEvents = parseNdjson(await streamError.text());
  assert.equal(errorEvents.find((event) => event.type === "error")?.value, "Mock overload");

  const imageAttachment = {
    name: "pixel.png",
    mime: "image/png",
    kind: "image",
    dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2kS8AAAAASUVORK5CYII="
  };

  const imageResponses = await chat(goModel, "", [imageAttachment]);
  assert.equal(imageResponses.status, 200);
  await imageResponses.text();
  assert.deepEqual(observations.goResponsePayloads.at(-1).input.at(-1).content.map((part) => part.type), ["input_image"]);

  const imageChat = await chat(grokModel, "", [imageAttachment]);
  assert.equal(imageChat.status, 200);
  await imageChat.text();
  assert.deepEqual(observations.goChatPayloads.at(-1).messages.at(-1).content.map((part) => part.type), ["image_url"]);

  const imageMessages = await chat(qwenModel, "", [imageAttachment]);
  assert.equal(imageMessages.status, 200);
  await imageMessages.text();
  assert.deepEqual(observations.goMessagePayloads.at(-1).messages.at(-1).content.map((part) => part.type), ["image"]);

  const imageAnthropic = await chat(claudeModel, "", [imageAttachment]);
  assert.equal(imageAnthropic.status, 200);
  await imageAnthropic.text();
  assert.deepEqual(observations.anthropicPayloads.at(-1).messages.at(-1).content.map((part) => part.type), ["image"]);

  const forbidden = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ provider: "opencode-go", model: "deepseek-v4-pro", modelToken: "invalid", messages: [{ role: "user", content: "hidden" }] })
  });
  assert.equal(forbidden.status, 403);

  assert.ok(observations.goHeaders.length >= 9);
  assert.ok(observations.anthropicHeaders.length >= 4);
  assert.equal(observations.goResponsePayloads.length, 4);
  assert.equal(observations.goChatPayloads.length, 2);
  assert.equal(observations.goMessagePayloads.length, 2);
  assert.equal(observations.anthropicPayloads.length, 3);
  console.log("integration ok: auth, provider isolation, all Go protocols, stream failure/truncation, Claude errors, and image-only payloads");
} finally {
  if (nextProcess && !nextProcess.killed) nextProcess.kill();
  await new Promise((resolve) => providerServer.close(resolve));
}
