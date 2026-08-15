/**
 * WP14：reasoning 截断自动重试判定（纯函数，可单测）。
 * 客户端流结束时判断：stop=length / max_tokens 截断 + 只有推理没有 final/artifact → 应自动重试一次。
 * 重试语义：最多一次（alreadyRetried），推理内容不进下一轮上下文（调用方处理）。
 */

export type RetryDecision = { retry: boolean; reason?: string };

export type TruncationInput = {
  /** 最终回答文本（trim 后）。 */
  finalText: string;
  /** 是否已有产物（artifact）。 */
  hasArtifact: boolean;
  /** 推理内容（trim 后）。 */
  finalReason: string;
  /** 流式终止原因（stop_reason / finish_reason）。 */
  stopReason?: string;
  /** 是否已为重试提高过预算（防止无限重试）。 */
  alreadyRetried: boolean;
};

export function shouldRetryForLengthTruncation(input: TruncationInput): RetryDecision {
  if (input.alreadyRetried) return { retry: false };
  if (input.finalText.trim() || input.hasArtifact) return { retry: false };
  if (!input.finalReason.trim()) return { retry: false };
  if (!/length|max_tokens/i.test(String(input.stopReason || ""))) return { retry: false };
  return { retry: true, reason: "reasoning truncated (stop=length), no final answer" };
}
