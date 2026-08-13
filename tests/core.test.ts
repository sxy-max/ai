import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { featuredAnthropicModelIds } from "../lib/anthropic";
import { accessConfigurationError, createSessionToken, passwordMatches, signModelAccess, verifyModelAccess, verifySessionToken } from "../lib/auth";
import { buildEvidenceContext, normalizeSources } from "../lib/exa";
import { featuredModelIds, protocolForModel } from "../lib/opencode";
import { safePublicHttpUrl } from "../lib/urls";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

test("provider routing keeps Anthropic and OpenCode Go isolated", () => {
  assert.equal(protocolForModel("gpt-5.6-luna", "opencode-go"), "responses");
  assert.equal(protocolForModel("grok-4.5", "opencode-go"), "chat");
  assert.equal(protocolForModel("qwen3.8-max", "opencode-go"), "messages");
  assert.equal(protocolForModel("claude-sonnet-5", "anthropic"), "anthropic");
  assert.equal(protocolForModel("anthropic/claude-sonnet-5"), "anthropic");
  assert.equal(protocolForModel("anthropic/claude-sonnet-5", "opencode-go"), null);
  assert.equal(protocolForModel("grok-4.5", "anthropic"), null);
});

test("featured models add one stable Claude only when it is available", () => {
  delete process.env.FEATURED_MODELS;
  delete process.env.ANTHROPIC_FEATURED_MODELS;
  const claude = featuredAnthropicModelIds([
    { id: "claude-opus-5" },
    { id: "claude-sonnet-5" },
    { id: "claude-haiku-4-5-20251001" }
  ]);
  assert.deepEqual(claude, ["claude-sonnet-5"]);
  assert.deepEqual(featuredModelIds(claude), [
    "gpt-5.6-luna",
    "anthropic/claude-sonnet-5",
    "grok-4.5",
    "kimi-k3",
    "qwen3.8-max",
    "glm-5.2",
    "minimax-m3",
    "deepseek-v4-pro"
  ]);
});

test("explicit featured model order accepts raw Claude IDs", () => {
  process.env.FEATURED_MODELS = "claude-opus-5,grok-4.5";
  assert.deepEqual(featuredModelIds(["claude-sonnet-5"]), ["anthropic/claude-opus-5", "grok-4.5"]);
});

test("production access password fails closed and signed tokens use separate secrets", () => {
  Object.assign(process.env, {
    NODE_ENV: "production",
    OPENCODE_GO_API_KEY: "go-provider-key-a",
    ANTHROPIC_API_KEY: "anthropic-provider-key-a",
    ALLOW_OTHER_MODELS: "false",
    FEATURED_MODELS: "",
    ANTHROPIC_FEATURED_MODELS: ""
  });
  delete process.env.MODEL_TOKEN_SECRET;
  delete process.env.ACCESS_PASSWORD;
  assert.match(accessConfigurationError() || "", /required/);
  process.env.ACCESS_PASSWORD = "short";
  assert.match(accessConfigurationError() || "", /12/);
  process.env.ACCESS_PASSWORD = "correct-horse-battery-staple";
  assert.equal(accessConfigurationError(), null);
  assert.equal(passwordMatches("correct-horse-battery-staple"), true);
  assert.equal(passwordMatches("wrong"), false);

  const session = createSessionToken();
  assert.equal(verifySessionToken(session), true);
  assert.equal(verifySessionToken(`${session}x`), false);

  const token = signModelAccess("anthropic", "claude-sonnet-5");
  assert.equal(verifyModelAccess(token, "anthropic", "claude-sonnet-5"), true);
  assert.equal(verifyModelAccess(token, "opencode-go", "claude-sonnet-5"), false);
  assert.equal(verifyModelAccess(token, "anthropic", "claude-opus-5"), false);

  process.env.ACCESS_PASSWORD = "another-correct-horse-battery-staple";
  assert.equal(verifySessionToken(session), false);
  assert.equal(verifyModelAccess(token, "anthropic", "claude-sonnet-5"), true);

  process.env.ANTHROPIC_API_KEY = "anthropic-provider-key-b";
  assert.equal(verifyModelAccess(token, "anthropic", "claude-sonnet-5"), false);
  process.env.ANTHROPIC_API_KEY = "anthropic-provider-key-a";

  process.env.ALLOW_OTHER_MODELS = "true";
  assert.equal(verifyModelAccess(token, "anthropic", "claude-sonnet-5"), false);

  process.env.ALLOW_OTHER_MODELS = "false";
  process.env.MODEL_TOKEN_SECRET = "dedicated-server-only-model-secret";
  const dedicatedToken = signModelAccess("anthropic", "claude-sonnet-5");
  process.env.ANTHROPIC_API_KEY = "anthropic-provider-key-c";
  assert.equal(verifyModelAccess(dedicatedToken, "anthropic", "claude-sonnet-5"), true);
  process.env.MODEL_TOKEN_SECRET = "rotated-server-only-model-secret";
  assert.equal(verifyModelAccess(dedicatedToken, "anthropic", "claude-sonnet-5"), false);
});

test("URL policy only accepts public HTTP and HTTPS URLs", () => {
  assert.equal(safePublicHttpUrl("https://example.com/path#fragment"), "https://example.com/path");
  assert.equal(safePublicHttpUrl("javascript:alert(1)"), null);
  assert.equal(safePublicHttpUrl("http://localhost/admin"), null);
  assert.equal(safePublicHttpUrl("http://127.0.0.1/admin"), null);
  assert.equal(safePublicHttpUrl("http://169.254.169.254/latest/meta-data"), null);
  assert.equal(safePublicHttpUrl("http://10.0.0.1/"), null);
  assert.equal(safePublicHttpUrl("https://user:pass@example.com/"), null);
});

test("Exa source normalization drops unsafe links but preserves evidence text", () => {
  const sources = normalizeSources(JSON.stringify({ results: [
    { title: "Safe", url: "https://example.com/a", text: "safe evidence" },
    { title: "Unsafe", url: "javascript:alert(1)", text: "still untrusted data" }
  ] }));
  assert.equal(sources[0].url, "https://example.com/a");
  assert.equal(sources[1].url, "");
  const context = buildEvidenceContext(sources);
  assert.match(context, /safe evidence/);
  assert.match(context, /still untrusted data/);
});
