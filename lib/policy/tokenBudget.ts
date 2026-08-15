/**
 * TokenBudgetManager（V1.2 WP5，P0）：
 * 动态 token / reasoning 预算，替代"出问题就调大 max_tokens"的补丁。
 *
 * 预算等级（tier）：tiny → normal → reasoning → deep_reasoning → artifact_planning → tool_loop。
 * 核心行为：
 *   1. budgetFor()：按模型/任务类型/推理模式/产物类型/尝试次数计算预算
 *   2. nextTierAfterTruncation()：stop=length + final 空 + reasoning 非空 → 升级一档重试
 *      （按档位升级，不是简单乘 10；有上限保护）
 *   3. BudgetTrace：记录 initialBudget/retryBudget/reasoningTokens/outputTokens/stopReason，
 *      由调用方持久化到任务执行元数据。
 */

import type { CapabilityId } from "./capabilities";

export type BudgetTier = "tiny" | "normal" | "reasoning" | "deep_reasoning" | "artifact_planning" | "tool_loop";

export type BudgetConfig = {
  /** 输出预算（max_tokens 语义，模型侧总/输出预算视 provider 而定）。 */
  maxOutputTokens: number;
  /** 推理提示（claude 系 reasoning_effort / 文本指令；非推理模型忽略）。 */
  reasoningHint?: "off" | "low" | "medium" | "high";
  label: string;
};

const TIERS: Record<BudgetTier, BudgetConfig> = {
  tiny: { maxOutputTokens: 512, reasoningHint: "low", label: "极小" },
  normal: { maxOutputTokens: 2048, reasoningHint: "low", label: "常规" },
  reasoning: { maxOutputTokens: 4096, reasoningHint: "medium", label: "推理" },
  deep_reasoning: { maxOutputTokens: 8192, reasoningHint: "high", label: "深度推理" },
  artifact_planning: { maxOutputTokens: 8192, reasoningHint: "medium", label: "产物规划" },
  tool_loop: { maxOutputTokens: 2048, reasoningHint: "low", label: "工具循环" },
};

/** 各档位的单步预算上限（防止单次给巨大预算；Agent tool loop 用）。 */
export const TIER_STEP_CAPS: Partial<Record<BudgetTier, number>> = {
  tool_loop: 1024,
};

const TIER_ORDER: BudgetTier[] = ["tiny", "normal", "reasoning", "deep_reasoning", "artifact_planning", "tool_loop"];

export function tierConfig(tier: BudgetTier): BudgetConfig {
  return TIERS[tier];
}

export type BudgetRequest = {
  model: string;
  taskType: string;
  reasoningMode: "none" | "auto" | "high";
  artifactKind?: string;
  attemptNumber?: number;
  /** 是否在 Agent tool loop 内（每 step 限预算）。 */
  inToolLoop?: boolean;
};

export type BudgetDecision = {
  tier: BudgetTier;
  maxOutputTokens: number;
  reasoningHint?: BudgetConfig["reasoningHint"];
};

/**
 * 计算本轮执行预算。
 * 规则（deterministic-first）：
 *   - 工具循环内：tool_loop 档（每 step 限预算，不一次给巨大预算）
 *   - 产物规划（PPT/文档内容）：artifact_planning
 *   - 高推理需求：deep_reasoning（模型具备推理能力时）
 *   - 推理自动：reasoning
 *   - 其余：normal；首轮 tiny（尝试廉价路径）
 */
export function budgetFor(request: BudgetRequest): BudgetDecision {
  if (request.inToolLoop) return { tier: "tool_loop", ...TIERS.tool_loop };
  const taskType = String(request.taskType || "");
  if (/artifact_generation|presentation|pptx/.test(taskType) || /pptx|docx|presentation/.test(String(request.artifactKind || ""))) {
    return { tier: "artifact_planning", ...TIERS.artifact_planning };
  }
  if (request.reasoningMode === "high") return { tier: "deep_reasoning", ...TIERS.deep_reasoning };
  const firstTry = (request.attemptNumber ?? 0) <= 0;
  if (request.reasoningMode === "auto") {
    // 首轮走廉价档（tiny），截断后由 nextTierAfterTruncation 升档
    return firstTry ? { tier: "tiny", ...TIERS.tiny } : { tier: "reasoning", ...TIERS.reasoning };
  }
  return firstTry ? { tier: "tiny", ...TIERS.tiny } : { tier: "normal", ...TIERS.normal };
}

export type TruncationEvidence = {
  stopReason?: string;
  /** final 文本（trim 后）。 */
  finalEmpty: boolean;
  /** reasoning 内容非空。 */
  reasoningNonEmpty: boolean;
  /** 是否已重试过（防止无限升级）。 */
  alreadyRetried: boolean;
};

export type TruncationResult = {
  upgrade: boolean;
  next?: BudgetDecision;
  reason?: string;
};

/**
 * stop=length + final 空 + reasoning 非空 → 升级一档（tiny→normal→reasoning→deep_reasoning）。
 * 非截断或已重试 → 不升级。最多升到 deep_reasoning（上限保护，不无限涨）。
 */
export function nextTierAfterTruncation(currentTier: BudgetTier, evidence: TruncationEvidence): TruncationResult {
  if (evidence.alreadyRetried) return { upgrade: false, reason: "already_retried" };
  if (!evidence.finalEmpty) return { upgrade: false, reason: "final_present" };
  if (!evidence.reasoningNonEmpty) return { upgrade: false, reason: "no_reasoning_evidence" };
  if (!/length|max_tokens/i.test(String(evidence.stopReason || ""))) return { upgrade: false, reason: "not_truncated" };

  const index = TIER_ORDER.indexOf(currentTier);
  if (index < 0) return { upgrade: false, reason: "unknown_tier" };
  // 工具循环/产物规划档在截断时升到 reasoning 档（语义：脱离 step 级限制）
  const candidates = ["tiny", "normal", "reasoning", "deep_reasoning"] as const;
  const currentRank = candidates.indexOf(currentTier as (typeof candidates)[number]);
  if (currentRank < 0 || currentRank >= candidates.length - 1) {
    return { upgrade: false, reason: "tier_at_cap" };
  }
  const nextTier = candidates[currentRank + 1];
  return { upgrade: true, next: { tier: nextTier, ...TIERS[nextTier] }, reason: `budget_upgrade:${currentTier}->${nextTier}` };
}

/** 执行轨迹（由调用方持久化到任务元数据 / metrics）。 */
export type BudgetTrace = {
  initialTier: BudgetTier;
  initialBudget: number;
  retryTier?: BudgetTier;
  retryBudget?: number;
  reasoningTokens?: number;
  outputTokens?: number;
  stopReason?: string;
};

export function traceOf(initial: BudgetDecision, retry?: { decision: BudgetDecision; evidence: TruncationEvidence }): BudgetTrace {
  const trace: BudgetTrace = { initialTier: initial.tier, initialBudget: initial.maxOutputTokens };
  if (retry) {
    trace.retryTier = retry.decision.tier;
    trace.retryBudget = retry.decision.maxOutputTokens;
    trace.stopReason = retry.evidence.stopReason;
  }
  return trace;
}

export function budgetTierLabel(tier: BudgetTier): string {
  return TIERS[tier].label;
}

export type { CapabilityId };
