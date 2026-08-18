/** ProviderHealthRegistry + FallbackGraph 测试（V1.2 WP18-19）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderHealthRegistry } from "../../lib/policy/providerHealth";
import { fallbackFor, FALLBACK_CHAINS } from "../../lib/policy/fallbackGraph";

/* ---------- WP18 ProviderHealth ---------- */

test("Runtime Profile 状态：Luna 等待真实探测、Grok disabled", () => {
  const registry = new ProviderHealthRegistry();
  assert.equal(registry.statusOf("gpt-5.6-luna"), "available");
  assert.equal(registry.statusOf("grok-4.5"), "disabled");
  assert.equal(registry.statusOf("deepseek-v4-flash"), "available");
});

test("disabled 产品硬禁用：探测/失败不改变", () => {
  const registry = new ProviderHealthRegistry();
  registry.recordFailure("grok-4.5", "HTTP_500");
  assert.equal(registry.statusOf("grok-4.5"), "disabled");
  registry.record("grok-4.5", { status: "temporary_unavailable", probedAt: Date.now() });
  assert.equal(registry.statusOf("grok-4.5"), "disabled");
});

test("失败记录：available → degraded；持续失败 → temporary_unavailable", () => {
  const registry = new ProviderHealthRegistry();
  assert.equal(registry.recordFailure("deepseek-v4-flash", "HTTP_503"), "degraded");
  assert.equal(registry.isAvailable("deepseek-v4-flash"), false);
  assert.equal(registry.recordFailure("deepseek-v4-flash", "HTTP_503"), "degraded");
  assert.equal(registry.statusOf("deepseek-v4-flash"), "degraded");
});

test("region 判定：403/区域错误体 → region_unavailable（Luna 根因记录）", () => {
  const registry = new ProviderHealthRegistry();
  registry.record("gpt-5.6-luna", {
    status: "region_unavailable",
    errorCode: "HTTP_403",
    errorBody: "region not supported",
    endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
    probedAt: Date.now(),
  });
  assert.equal(registry.statusOf("gpt-5.6-luna"), "region_unavailable");
});

test("探测新鲜度：TTL 内不重复探测；过期可再探测", () => {
  const registry = new ProviderHealthRegistry(60_000);
  const now = 1_000_000;
  registry.record("m", { status: "degraded", probedAt: now });
  assert.equal(registry.shouldProbe("m", now + 10_000), false);
  assert.equal(registry.shouldProbe("m", now + 120_000), true);
  assert.equal(registry.shouldProbe("unknown-model", now), true);
});

test("availableModels 过滤 + snapshot", () => {
  const registry = new ProviderHealthRegistry();
  registry.record("deepseek-v4-flash", { status: "degraded", probedAt: Date.now() });
  const available = registry.availableModels(["deepseek-v4-flash", "deepseek-v4-pro", "grok-4.5", "gpt-5.6-luna"]);
  assert.deepEqual(available, ["deepseek-v4-pro", "gpt-5.6-luna"]);
  const snap = registry.snapshot();
  assert.equal(snap["grok-4.5"], "disabled");
});

/* ---------- WP19 FallbackGraph ---------- */

test("复杂推理降级：Luna 不可用 → Flash", () => {
  const result = fallbackFor({
    role: "reasoning",
    failedModel: "gpt-5.6-luna",
    availableModels: ["glm-5.2", "deepseek-v4-flash", "qwen3.8-max"],
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.model, "deepseek-v4-flash");
});

test("Agent 降级：flash 不可用时不回到旧 pro 配置", () => {
  const result = fallbackFor({
    role: "agent",
    failedModel: "deepseek-v4-flash",
    availableModels: ["kimi-k3", "deepseek-v4-pro"],
  });
  assert.equal(result.ok, false);
});

test("Vision 降级：无 vision 模型可用 → 明确失败（不硬选无视觉模型）", () => {
  const result = fallbackFor({
    role: "vision",
    failedModel: "minimax-m3",
    availableModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no capable available model/);
});

test("capability-safe：available 但能力不足的模型被跳过", () => {
  const result = fallbackFor({
    role: "vision",
    failedModel: "minimax-m3",
    availableModels: ["deepseek-v4-pro", "qwen3.8-max", "glm-5.2"],
  });
  assert.equal(result.ok, false, "这些模型都没有 vision 能力");
});

test("chat 降级链与 ModelPolicy 一致", () => {
  assert.deepEqual(FALLBACK_CHAINS.chat, ["gpt-5.6-luna", "deepseek-v4-flash"]);
  assert.deepEqual(FALLBACK_CHAINS.reasoning, ["gpt-5.6-luna", "deepseek-v4-flash"]);
});
