import { NextResponse } from "next/server";
import { anthropicCapabilities, anthropicSelectionId, featuredAnthropicModelIds, listAnthropicModels, type AnthropicModel } from "../../../lib/anthropic";
import { accessConfigurationError, isAuthorized, signModelAccess } from "../../../lib/auth";
import { timeoutSignal } from "../../../lib/http";
import { allowOtherModels, API_ROOT, capabilitiesForModel, featuredModelIds, featuredModelMeta, hasConfiguredFeaturedModels } from "../../../lib/opencode";
import { modelPolicy } from "../../../lib/modelPolicy";
import { checkRateLimit } from "../../../lib/rate-limit";
import { providerHealthRegistry } from "../../../lib/policy/providerHealth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type RawOpenCodeModel = Record<string, unknown> & { id: string };

async function listOpenCodeModels(key: string, parentSignal: AbortSignal) {
  const timeout = timeoutSignal(parentSignal, 15_000);
  try {
    const upstream = await fetch(`${API_ROOT}/models`, {
      headers: { authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: timeout.signal
    });
    if (!upstream.ok) throw new Error(`OpenCode Go models failed (${upstream.status})`);
    const json = await upstream.json() as { data?: unknown };
    if (!Array.isArray(json.data)) throw new Error("OpenCode Go models returned an invalid payload");
    return json.data.filter((model): model is RawOpenCodeModel => Boolean(model) && typeof model === "object" && typeof (model as { id?: unknown }).id === "string");
  } finally {
    timeout.dispose();
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message.slice(0, 180) : fallback;
}

export async function GET(request: Request) {
  const configurationError = accessConfigurationError();
  if (configurationError) return NextResponse.json({ error: configurationError }, { status: 503 });
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rate = checkRateLimit(request, "models", 60);
  if (!rate.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": String(rate.retryAfter) } });

  const goKey = process.env.OPENCODE_GO_API_KEY || "";
  const anthropicKey = process.env.ANTHROPIC_API_KEY || "";
  const E2E = process.env.E2E_MODE === "1" && process.env.NODE_ENV !== "production";
  const MOCK_MODELS = ["mock-lifecycle", "mock-reasoning-final", "mock-reasoning-only", "mock-html-150", "mock-katex", "mock-code"];
  const [goResult, anthropicResult] = await Promise.allSettled([
    goKey ? listOpenCodeModels(goKey, request.signal) : Promise.resolve([] as RawOpenCodeModel[]),
    anthropicKey ? listAnthropicModels(anthropicKey, request.signal) : Promise.resolve([] as AnthropicModel[])
  ]);

  const providerErrors: Partial<Record<"opencode-go" | "anthropic", string>> = {};
  const goModels = goResult.status === "fulfilled" ? goResult.value : [];
  const anthropicModels = anthropicResult.status === "fulfilled" ? anthropicResult.value : [];
  if (goResult.status === "rejected") providerErrors["opencode-go"] = errorMessage(goResult.reason, "OpenCode Go models unavailable");
  if (anthropicResult.status === "rejected") providerErrors.anthropic = errorMessage(anthropicResult.reason, "Anthropic models unavailable");
  if (!goKey && !anthropicKey && !E2E) return NextResponse.json({ error: "Configure OPENCODE_GO_API_KEY or ANTHROPIC_API_KEY" }, { status: 503 });
  if (!goModels.length && !anthropicModels.length && !E2E) {
    return NextResponse.json({ error: "No model provider is currently available", providerErrors }, { status: 502 });
  }

  const claudeFeatured = featuredAnthropicModelIds(anthropicModels);
  const featuredIds = featuredModelIds(claudeFeatured);
  const featured = new Set(featuredIds);
  if (E2E) for (const id of MOCK_MODELS) featured.add(id);
  const allowOther = allowOtherModels();

  // V1.3 WP23：后台 probe 缓存（Redis）→ 本进程 registry（模型状态不再依赖即时探测）
  try {
    const { readProbeResults, applyProbeCacheToRegistry } = await import("../../../lib/policy/providerProbe");
    applyProbeCacheToRegistry(await readProbeResults());
  } catch {}

  const normalizedGo = goModels.map((raw) => {
    const capabilities = capabilitiesForModel(raw.id, raw);
    return {
      key: raw.id,
      id: raw.id,
      displayName: raw.id,
      ...capabilities,
      // V1.3 WP23：真实 provider 状态（available/degraded/region_blocked/unavailable/disabled）
      healthStatus: providerHealthRegistry.statusOf(raw.id),
      providerMeta: {
        contextWindow: raw.context_window ?? raw.context_length ?? null,
        maxOutput: raw.max_output_tokens ?? null,
        ownedBy: raw.owned_by ?? null
      },
      modelToken: signModelAccess("opencode-go", raw.id),
      temperaturePolicy: modelPolicy(raw.id).temperature,
      reasoningPolicy: modelPolicy(raw.id).reasoning,
      ...featuredModelMeta(raw.id, featuredIds)
    };
  });

  const normalizedAnthropic = anthropicModels.map((raw) => {
    const key = anthropicSelectionId(raw.id);
    const capabilities = anthropicCapabilities(raw);
    return {
      key,
      id: raw.id,
      displayName: raw.display_name || raw.id,
      provider: "anthropic" as const,
      protocol: "anthropic" as const,
      supported: true,
      reasoning: capabilities.reasoning ? true as const : "unknown" as const,
      vision: capabilities.vision ? true as const : "unknown" as const,
      files: "native-or-extract" as const,
      web: "client-auto-search" as const,
      providerMeta: {
        contextWindow: raw.max_input_tokens ?? null,
        maxOutput: raw.max_tokens ?? null,
        createdAt: raw.created_at ?? null,
        capabilities: capabilities.raw
      },
      modelToken: signModelAccess("anthropic", raw.id),
      temperaturePolicy: modelPolicy(raw.id).temperature,
      reasoningPolicy: modelPolicy(raw.id).reasoning,
      ...featuredModelMeta(key, featuredIds)
    };
  });

  const mockList = E2E ? MOCK_MODELS.map((id) => ({ key: id, id, displayName: id, provider: "opencode-go", protocol: null, supported: true, reasoning: false, vision: false, files: "", web: "", modelToken: signModelAccess("opencode-go", id), featuredRank: 99, useCase: "E2E Mock" })) : [];
  const allModels = [...mockList, ...normalizedGo, ...normalizedAnthropic];
  const models = (allowOther ? allModels : allModels.filter((model) => featured.has(model.key)))
    .sort((a, b) => {
      if (a.featuredRank !== null && b.featuredRank !== null) return a.featuredRank - b.featuredRank;
      if (a.featuredRank !== null) return -1;
      if (b.featuredRank !== null) return 1;
      return a.displayName.localeCompare(b.displayName);
    });

  const warnings: string[] = [];
  if (!goKey) warnings.push("OpenCode Go is not configured; only Anthropic models are available.");
  if (goKey && providerErrors["opencode-go"]) warnings.push(providerErrors["opencode-go"]!);
  if (anthropicKey && providerErrors.anthropic) warnings.push(providerErrors.anthropic);
  if (!models.length && !allowOther) {
    warnings.push(hasConfiguredFeaturedModels()
      ? "FEATURED_MODELS did not match an available model."
      : "The built-in featured models were not returned by the configured providers.");
  }

  return NextResponse.json({
    models,
    allowOtherModels: allowOther,
    warnings,
    providers: {
      "opencode-go": { configured: Boolean(goKey), available: goModels.length > 0 },
      anthropic: { configured: Boolean(anthropicKey), available: anthropicModels.length > 0 }
    }
  });
}
