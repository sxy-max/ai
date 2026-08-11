import { timeoutSignal } from "./http";

export const ANTHROPIC_API_ROOT = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1").replace(/\/+$/, "");
export const ANTHROPIC_API_VERSION = "2023-06-01";
export const ANTHROPIC_PREFIX = "anthropic/";

export type AnthropicModel = {
  id: string;
  display_name?: string;
  created_at?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: Record<string, unknown>;
};

export function anthropicHeaders(key: string) {
  return {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_API_VERSION
  };
}

export function anthropicSelectionId(model: string) {
  return model.startsWith(ANTHROPIC_PREFIX) ? model : `${ANTHROPIC_PREFIX}${model}`;
}

export function rawAnthropicModelId(model: string) {
  return model.startsWith(ANTHROPIC_PREFIX) ? model.slice(ANTHROPIC_PREFIX.length) : model;
}

export function isAnthropicSelection(model: string) {
  return model.startsWith(ANTHROPIC_PREFIX) && /^claude-[a-z0-9][a-z0-9._-]*$/i.test(rawAnthropicModelId(model));
}

export async function listAnthropicModels(key: string, parentSignal?: AbortSignal) {
  const models: AnthropicModel[] = [];
  let afterId = "";

  for (let page = 0; page < 10; page += 1) {
    const url = new URL(`${ANTHROPIC_API_ROOT}/models`);
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const timeout = timeoutSignal(parentSignal, 15_000);
    try {
      const response = await fetch(url, {
        headers: anthropicHeaders(key),
        cache: "no-store",
        signal: timeout.signal
      });
      if (!response.ok) throw new Error(`Anthropic models failed (${response.status})`);
      const json = await response.json() as { data?: unknown; has_more?: unknown; last_id?: unknown };
      if (!Array.isArray(json.data)) throw new Error("Anthropic models returned an invalid payload");
      for (const item of json.data) {
        if (item && typeof item === "object" && typeof (item as AnthropicModel).id === "string") models.push(item as AnthropicModel);
      }
      if (json.has_more !== true || typeof json.last_id !== "string" || !json.last_id) break;
      afterId = json.last_id;
    } finally {
      timeout.dispose();
    }
  }

  return models;
}

function capabilitySupported(value: unknown) {
  if (typeof value === "boolean") return value;
  return Boolean(value && typeof value === "object" && (value as { supported?: unknown }).supported === true);
}

export function anthropicCapabilities(model: AnthropicModel) {
  const capabilities = model.capabilities || {};
  return {
    reasoning: capabilitySupported(capabilities.thinking) || capabilitySupported(capabilities.effort),
    vision: capabilitySupported(capabilities.image_input),
    raw: capabilities
  };
}

const DEFAULT_STABLE_SONNETS = [
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929"
];

function configuredClaudeFeatured() {
  return (process.env.ANTHROPIC_FEATURED_MODELS || "").split(",")
    .map((id) => rawAnthropicModelId(id.trim()))
    .filter(Boolean);
}

export function featuredAnthropicModelIds(models: AnthropicModel[]) {
  const available = new Set(models.map((model) => model.id));
  const configured = configuredClaudeFeatured();
  if (configured.length) return configured.filter((id) => available.has(id));

  const exact = DEFAULT_STABLE_SONNETS.find((id) => available.has(id));
  if (exact) return [exact];
  const stableSonnet = models.find((model) => /^claude-sonnet-/i.test(model.id) && !/(beta|preview|deprecated)/i.test(model.id));
  return stableSonnet ? [stableSonnet.id] : [];
}

export function anthropicUseCase(model: string) {
  if (/claude-sonnet/i.test(model)) return "智能与速度平衡";
  if (/claude-opus/i.test(model)) return "高难推理/复杂工作";
  if (/claude-haiku/i.test(model)) return "快速/低成本";
  return "Claude 模型";
}

export function anthropicMessagesEndpoint() {
  return `${ANTHROPIC_API_ROOT}/messages`;
}
