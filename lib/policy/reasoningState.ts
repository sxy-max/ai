/**
 * ReasoningExecutionState（V1.2 WP6）：
 * 推理模型执行状态的正式定义。UI 的"已完成"只允许在 final 或 artifact 完成后出现；
 * 推理被截断时显示"推理达到本轮预算，正在继续"，而不是"已完成"。
 */

export type ReasoningExecutionState =
  | "reasoning_streaming" // 正在推理（尚未产出 final）
  | "final_streaming"    // 正在产出 final
  | "truncated_reasoning" // stop=length 且无 final（预算被推理耗尽）
  | "completed"          // final 或 artifact 完成
  | "incomplete";        // 其他未完成形态（无 final、无 artifact、非截断）

export type ReasoningObservation = {
  /** 已流式收到的 final 文本（未 trim）。 */
  text: string;
  /** 已流式收到的推理文本。 */
  reasoning: string;
  /** 流终止原因（stop_reason / finish_reason）。 */
  stopReason?: string;
  /** 是否已有 artifact。 */
  hasArtifact?: boolean;
};

/** 从流状态推导执行状态（纯函数）。 */
export function deriveReasoningState(obs: ReasoningObservation): ReasoningExecutionState {
  const finalText = String(obs.text || "").trim();
  const hasReasoning = String(obs.reasoning || "").trim().length > 0;
  if (finalText || obs.hasArtifact) return "completed";
  if (!obs.stopReason) return hasReasoning ? "reasoning_streaming" : "incomplete";
  if (/length|max_tokens/i.test(String(obs.stopReason))) {
    return hasReasoning ? "truncated_reasoning" : "incomplete";
  }
  return hasReasoning ? "incomplete" : "incomplete";
}

/** UI 文案（无 final 时禁止"已完成"）。 */
export function reasoningStateLabel(state: ReasoningExecutionState): string {
  switch (state) {
    case "reasoning_streaming": return "推理中";
    case "final_streaming": return "生成回答中";
    case "truncated_reasoning": return "推理达到本轮预算，正在继续";
    case "completed": return "已完成";
    case "incomplete": return "未完成";
  }
}

/**
 * 截断时的下一步动作（与 TokenBudgetManager 衔接）：
 * truncated_reasoning → 预算升级重试（一次）；其余不升级。
 */
export function nextActionAfterReasoning(obs: ReasoningObservation, alreadyRetried: boolean):
  { action: "budget_upgrade_retry" | "finalize" | "none"; state: ReasoningExecutionState } {
  const state = deriveReasoningState(obs);
  if (state === "truncated_reasoning" && !alreadyRetried) return { action: "budget_upgrade_retry", state };
  if (state === "completed") return { action: "finalize", state };
  return { action: "none", state };
}
