/**
 * RepairPolicyEngine（V1.2 WP23）：按失败分类选择修复动作。
 * 不做"所有错误统一再跑一次"：
 *   MODEL_REASONING_TRUNCATED → 预算升级
 *   ARTIFACT_MISSING → repair instruction（要求产出）
 *   ARTIFACT_INVALID → validator feedback 注入
 *   VISION_FAILED → vision 重试/降级
 *   RUNTIME_START_FAILED → runtime 重试/换 runtime
 */

import { classifyFailure, type FailureCode, type FailureClassification } from "./failureTaxonomy";

export type RepairAction =
  | { action: "budget_upgrade"; reason: string }
  | { action: "repair_instruction"; reason: string }
  | { action: "validator_feedback"; reason: string }
  | { action: "vision_retry"; reason: string }
  | { action: "runtime_fallback"; reason: string }
  | { action: "none"; reason: string };

export type RepairPolicyInput = {
  error?: unknown;
  /** 已尝试次数（防无限）。 */
  attempts: number;
  /** 最大允许次数。 */
  maxAttempts: number;
  /** 剩余尝试次数是否足以支撑动作（budget_upgrade 只能一次）。 */
  budgetUpgradeUsed?: boolean;
};

/** 失败码 → 修复动作（deterministic-first）。 */
export function repairActionFor(code: FailureCode, input: RepairPolicyInput): RepairAction {
  if (input.attempts >= input.maxAttempts) return { action: "none", reason: `attempts exhausted (${input.attempts}/${input.maxAttempts})` };
  switch (code) {
    case "MODEL_REASONING_TRUNCATED":
      if (input.budgetUpgradeUsed) return { action: "none", reason: "budget upgrade already used once" };
      return { action: "budget_upgrade", reason: "reasoning truncated: raise token budget by one tier" };
    case "MODEL_NO_FINAL":
      return { action: "repair_instruction", reason: "model produced reasoning only: re-prompt with delivery emphasis" };
    case "MODEL_UNAVAILABLE":
    case "MODEL_REGION_UNAVAILABLE":
      return { action: "none", reason: "model unavailable: capability-safe fallback required, not blind retry" };
    case "ARTIFACT_MISSING":
      return { action: "repair_instruction", reason: "expected artifact missing: re-run with explicit delivery contract" };
    case "ARTIFACT_INVALID":
    case "VALIDATION_FAILED":
      return { action: "validator_feedback", reason: "artifact failed format validation: inject validator feedback" };
    case "VISION_FAILED":
      return { action: "vision_retry", reason: "vision preprocessing failed: retry vision (bounded)" };
    case "RUNTIME_START_FAILED":
      return { action: "runtime_fallback", reason: "runtime failed to start: retry or fallback runtime" };
    case "RUNTIME_TIMEOUT":
      return { action: "runtime_fallback", reason: "runtime timeout: retry with fallback runtime" };
    case "TOOL_FAILED":
      return { action: "repair_instruction", reason: "tool failed: re-run with tool guidance" };
    case "TASK_CANCELLED":
      return { action: "none", reason: "task cancelled by user" };
    case "WORKSPACE_FAILED":
      return { action: "none", reason: "workspace failure is not retryable (security/limits)" };
    default:
      return { action: "none", reason: "unknown failure: no blind retry" };
  }
}

/** 便捷入口：错误对象 → 分类 → 修复动作。 */
export function planRepair(input: RepairPolicyInput): { classification: FailureClassification; repair: RepairAction } {
  const classification = classifyFailure(input.error);
  const repair = repairActionFor(classification.code, input);
  return { classification, repair };
}
