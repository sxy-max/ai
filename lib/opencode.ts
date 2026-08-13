import { anthropicMessagesEndpoint, anthropicSelectionId, anthropicUseCase, isAnthropicSelection, rawAnthropicModelId } from "./anthropic";

export type Provider = "opencode-go" | "anthropic";
export type Protocol = "chat" | "messages" | "responses" | "anthropic";
export type CapabilityState = true | false | "unknown";

export type ModelCapabilities = {
  provider: Provider;
  protocol: Protocol | null;
  supported: boolean;
  reasoning: CapabilityState;
  vision: CapabilityState;
  files: "text-extract" | "native-or-extract";
  web: "client-search" | "client-auto-search";
};

export const API_ROOT = (process.env.OPENCODE_GO_BASE_URL || "https://opencode.ai/zen/go/v1").replace(/\/+$/, "");

export const DEFAULT_FEATURED_MODEL_IDS = [
  "gpt-5.6-luna",
  "grok-4.5",
  "kimi-k3",
  "qwen3.8-max",
  "glm-5.2",
  "minimax-m3",
  "deepseek-v4-pro"
];

const FEATURED_MODEL_USE_CASES: Record<string, string> = {
  "gpt-5.6-luna": "最强综合/复杂任务",
  "grok-4.5": "强表达/开放问答",
  "kimi-k3": "前端/多步执行",
  "glm-5.2": "中文综合/稳定思考",
  "deepseek-v4-flash": "高频快速备用",
  "deepseek-v4-pro": "DeepSeek/中国 · 稳定推理",
  "minimax-m3": "MiniMax/中国 · 长文/工具",
  "qwen3.8-max": "阿里/中国 · 强模型"
};

function normalizeFeaturedId(id: string) {
  const trimmed = id.trim();
  return /^claude-/i.test(trimmed) ? anthropicSelectionId(trimmed) : trimmed;
}

export function hasConfiguredFeaturedModels() {
  return Boolean((process.env.FEATURED_MODELS || "").split(",").map((x) => x.trim()).find(Boolean));
}

export function featuredModelIds(anthropicModels: string[] = []) {
  const configured = (process.env.FEATURED_MODELS || "").split(",").map(normalizeFeaturedId).filter(Boolean);
  if (configured.length) return configured;
  const claude = anthropicModels.map(anthropicSelectionId);
  return [DEFAULT_FEATURED_MODEL_IDS[0], ...claude, ...DEFAULT_FEATURED_MODEL_IDS.slice(1)];
}

export function allowOtherModels() {
  return String(process.env.ALLOW_OTHER_MODELS || "false").toLowerCase() === "true";
}

export function featuredModelMeta(model: string, featuredIds = featuredModelIds()) {
  const index = featuredIds.indexOf(model);
  return {
    featuredRank: index >= 0 ? index : null,
    useCase: index >= 0
      ? (isAnthropicSelection(model) ? anthropicUseCase(model) : FEATURED_MODEL_USE_CASES[model] || "推荐")
      : null
  };
}

const MESSAGE_MODELS = [/^minimax-/, /^qwen3\.[0-9]+-(max|plus)$/];
const RESPONSE_MODELS = [/^gpt-5\.6-luna$/];

export function protocolForModel(model: string, provider?: Provider): Protocol | null {
  const inferredProvider = provider || (isAnthropicSelection(model) ? "anthropic" : "opencode-go");
  if (inferredProvider === "anthropic") {
    const raw = rawAnthropicModelId(model);
    return /^claude-[a-z0-9][a-z0-9._-]*$/i.test(raw) ? "anthropic" : null;
  }
  if (isAnthropicSelection(model)) return null;
  if (RESPONSE_MODELS.some((pattern) => pattern.test(model))) return "responses";
  if (MESSAGE_MODELS.some((pattern) => pattern.test(model))) return "messages";
  if (/^(grok-|glm-|kimi-|deepseek-|mimo-|hy3)/.test(model)) return "chat";
  return null;
}

const KNOWN_VISION: Record<string, boolean> = { "kimi-k3": true, "glm-5.2": false };

export function capabilitiesForModel(model: string, raw: Record<string, unknown> = {}): ModelCapabilities {
  const protocol = protocolForModel(model, "opencode-go");
  const rawCapabilities = raw.capabilities && typeof raw.capabilities === "object" ? raw.capabilities as Record<string, unknown> : {};
  const inputModalities = raw.input_modalities || (raw.modalities as Record<string, unknown> | undefined)?.input || rawCapabilities.input || [];
  const hasImageMetadata = Array.isArray(inputModalities) && inputModalities.some((value) => String(value).toLowerCase().includes("image"));
  const explicitReasoning = raw.reasoning ?? rawCapabilities.reasoning;

  return {
    provider: "opencode-go",
    protocol,
    supported: Boolean(protocol),
    reasoning: typeof explicitReasoning === "boolean" ? explicitReasoning : "unknown",
    vision: KNOWN_VISION[model] ?? (hasImageMetadata ? true : "unknown"),
    files: "native-or-extract",
    web: "client-auto-search"
  };
}

export function endpointForProtocol(protocol: Protocol) {
  if (protocol === "chat") return `${API_ROOT}/chat/completions`;
  if (protocol === "messages") return `${API_ROOT}/messages`;
  if (protocol === "responses") return `${API_ROOT}/responses`;
  return anthropicMessagesEndpoint();
}

export function upstreamModelId(model: string, provider: Provider) {
  return provider === "anthropic" ? rawAnthropicModelId(model) : model;
}
