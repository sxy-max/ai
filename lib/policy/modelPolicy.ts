/**
 * ModelPolicyEngine（V1.2 WP4）：模型按能力分工。
 * 目标：模型只负责适合自己的部分，禁止"一个模型包打天下"。
 * 选择规则（deterministic-first）：
 *   A 普通知识/文本 → GPT 5.6 Luna，失败时回退 DeepSeek V4 Flash
 *   B 高难推理 → GPT 5.6 Luna，失败时回退 DeepSeek V4 Flash
 *   C 文件 Agent → deepseek-v4-flash（tool execution / instruction following 优先，非长推理）
 *   D Vision → MiniMax Vision（视觉模型只负责观察）
 *   E Artifact 内容 → content model + deterministic renderer
 *   F fallback → capability-safe 降级（必须满足任务需求，不随机换模型）
 */

import { capabilitiesForModel, modelHasCapability, type CapabilityId } from "./capabilities";

export type ModelRolePolicy = "chat" | "planner" | "content" | "agent" | "vision" | "reasoning";

export type ModelSelectionInput = {
  role: ModelRolePolicy;
  /** 任务需求能力（fallback 必须满足）。 */
  requiredCapabilities?: CapabilityId[];
  /** 当前可用模型列表（来自 ProviderHealth / /api/models）。 */
  availableModels?: string[];
  /** 用户/系统覆盖（env 配置，如 AGENT_MODEL）。 */
  configured?: { planner?: string; agent?: string; chat?: string; content?: string; vision?: string; reasoning?: string };
};

export type ModelSelectionResult = {
  model: string | null;
  role: ModelRolePolicy;
  /** 选择依据（审计用）。 */
  reason: string;
  /** 降级链（按顺序尝试；记录供指标）。 */
  fallbackTried: string[];
};

const DEFAULT_AVAILABLE = ["gpt-5.6-luna", "deepseek-v4-flash", "minimax-m3"];

type ResolvedConfig = {
  planner?: string;
  agent?: string;
  chat?: string;
  content?: string;
  vision?: string;
  reasoning?: string;
};

function resolveConfig(configured?: ModelSelectionInput["configured"]): ResolvedConfig {
  return {
    planner: configured?.planner || process.env.PLANNER_MODEL?.trim() || undefined,
    agent: configured?.agent || process.env.AGENT_MODEL?.trim() || undefined,
    chat: configured?.chat || process.env.CHAT_MODEL?.trim() || undefined,
    content: configured?.content || process.env.CONTENT_MODEL?.trim() || undefined,
    vision: configured?.vision || process.env.VISION_MODEL?.trim() || undefined,
    reasoning: configured?.reasoning || process.env.REASONING_MODEL?.trim() || undefined,
  };
}

/** 能力安全过滤：只保留满足全部 requiredCapabilities 的模型。 */
export function filterCapabilitySafe(required: CapabilityId[], models: string[]): string[] {
  if (!required.length) return models;
  return models.filter((model) => required.every((cap) => modelHasCapability(model, cap)));
}

/**
 * 选择模型。fallback 只在同角色候选内降级，且必须 capability-safe。
 * 返回 null 表示无可用模型（调用方给明确错误，不随机替换）。
 */
export function selectModel(input: ModelSelectionInput): ModelSelectionResult {
  const config = resolveConfig(input.configured);
  const available = input.availableModels !== undefined ? input.availableModels : DEFAULT_AVAILABLE;
  // 必须 capability-safe：过滤后为空意味着"无可用模型"，不允许回退到不满足需求的模型
  const candidates = filterCapabilitySafe(input.requiredCapabilities || [], available);
  const fallbackTried: string[] = [];

  const roleChains: Record<ModelRolePolicy, string[]> = {
    // A. 普通知识/文本：Luna；上游不可用时 Flash
    chat: [config.chat || "gpt-5.6-luna", "deepseek-v4-flash"],
    // 规划：内容模型即可（确定性规则优先于 LLM 规划）
    planner: [config.planner || "gpt-5.6-luna", "deepseek-v4-flash"],
    // E. 产物内容：稳定内容模型
    content: [config.content || "deepseek-v4-flash"],
    // C. 文件 Agent：tool execution 优先（flash），非长推理
    agent: [config.agent || "deepseek-v4-flash", "deepseek-v4-flash"],
    // B. 高难推理：reasoning model
    reasoning: [config.reasoning || "gpt-5.6-luna", "deepseek-v4-flash"],
    // D. 视觉：视觉模型只负责观察（Vision Specialist）
    vision: [config.vision || "minimax-m3"],
  };

  const chain = roleChains[input.role] || roleChains.chat;
  for (const model of chain) {
    if (candidates.includes(model)) {
      return { model, role: input.role, reason: `capability-safe chain hit: ${model}`, fallbackTried };
    }
    fallbackTried.push(model);
  }
  // 兜底：链外但能力安全的第一候选（不随机）
  if (candidates.length) {
    return { model: candidates[0], role: input.role, reason: `chain exhausted, capability-safe fallback: ${candidates[0]}`, fallbackTried };
  }
  return { model: null, role: input.role, reason: "no capable model available", fallbackTried };
}
