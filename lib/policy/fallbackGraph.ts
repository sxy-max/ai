/**
 * FallbackGraph（V1.2 WP19）：capability-safe 降级链。
 * 不做"model A fail → 随机 model B"；每条链都保证能力匹配任务需求，
 * 且降级目标必须是 available（ProviderHealthRegistry 过滤）。
 */

import { capabilitiesForModel, modelHasCapability, type CapabilityId } from "./capabilities";
import type { ModelRolePolicy } from "./modelPolicy";

/** 角色降级链（顺序即优先级；与 ModelPolicyEngine 角色链一致）。 */
export const FALLBACK_CHAINS: Record<ModelRolePolicy, string[]> = {
  chat: ["deepseek-v4-flash", "kimi-k3", "glm-5.2"],
  planner: ["deepseek-v4-pro", "deepseek-v4-flash"],
  content: ["deepseek-v4-pro", "deepseek-v4-flash"],
  agent: ["deepseek-v4-flash", "kimi-k3", "deepseek-v4-pro"],
  reasoning: ["deepseek-v4-pro", "qwen3.8-max", "glm-5.2", "deepseek-v4-flash"],
  vision: ["minimax-m3"],
};

export type FallbackInput = {
  role: ModelRolePolicy;
  /** 当前失败/不可用的模型。 */
  failedModel: string;
  /** 可用模型列表（ProviderHealthRegistry 过滤后）。 */
  availableModels: string[];
  /** 必须满足的能力（缺省按角色推断）。 */
  requiredCapabilities?: CapabilityId[];
};

export type FallbackResult =
  | { ok: true; model: string; reason: string }
  | { ok: false; reason: string };

function roleCapabilities(role: ModelRolePolicy): CapabilityId[] {
  switch (role) {
    case "vision": return ["vision"];
    case "reasoning": return ["reasoning", "text_generation"];
    case "agent": return ["tool_execution", "text_generation"];
    case "content": return ["text_generation"];
    case "planner": return ["text_generation"];
    default: return ["text_generation"];
  }
}

/** 按角色返回下一个 capability-safe 且 available 的模型（跳过 failedModel 与已尝试）。 */
export function fallbackFor(input: FallbackInput): FallbackResult {
  const required = input.requiredCapabilities?.length ? input.requiredCapabilities : roleCapabilities(input.role);
  const chain = FALLBACK_CHAINS[input.role] || FALLBACK_CHAINS.chat;
  const tried: string[] = [];
  for (const candidate of chain) {
    if (candidate === input.failedModel) continue;
    if (tried.includes(candidate)) continue;
    tried.push(candidate);
    if (!input.availableModels.includes(candidate)) continue;
    if (!required.every((cap) => modelHasCapability(candidate, cap))) continue;
    return { ok: true, model: candidate, reason: `fallback:${input.role}:${input.failedModel}->${candidate}` };
  }
  return { ok: false, reason: `fallback:${input.role}: no capable available model after ${input.failedModel}` };
}

/** 查看候选是否具备能力（供审计/测试）。 */
export function fallbackCapabilities(role: ModelRolePolicy): CapabilityId[] {
  return roleCapabilities(role);
}

export { capabilitiesForModel };
