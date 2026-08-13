// Message 生命周期: 流式状态机与结束判定
import type { Message, MessagePart, MessageStatus } from "./types";
import { textOf, hasArtifact } from "./types";

export type StreamAccumulator = {
  text: string;
  reasoning: string;
  parts: MessagePart[];
};

export function createAccumulator(): StreamAccumulator {
  return { text: "", reasoning: "", parts: [] };
}

/** 追加一个统一流事件到累积器 */
export function accumulate(acc: StreamAccumulator, event: { type: string; value?: string }): void {
  if (event.type === "text") {
    acc.text += event.value || "";
  } else if (event.type === "reasoning") {
    acc.reasoning += event.value || "";
  }
}

/** 流结束: 根据累积结果判定 message status */
export function finalizeStatus(acc: StreamAccumulator, hasArtifacts: boolean): MessageStatus {
  if (acc.text.trim().length === 0 && !hasArtifacts) {
    // reasoning-only 或空 → incomplete(有 reasoning) / failed(完全空)
    return acc.reasoning.trim().length > 0 ? "incomplete" : "failed";
  }
  return "complete";
}

/** 从累积器构建 assistant parts(text + reasoning 分离) */
export function partsFromAccumulator(acc: StreamAccumulator): MessagePart[] {
  const parts: MessagePart[] = [];
  if (acc.reasoning.trim()) {
    parts.push({ type: "reasoning", text: acc.reasoning, status: "complete" });
  }
  if (acc.text) {
    parts.push({ type: "text", text: acc.text });
  }
  return parts;
}

/** 发送前 sanitize: 过滤不可用于上游的 assistant(空 content 且无 artifact; 兼容 parts 结构) */
export type LooseMessage = { role: string; content?: string; artifacts?: unknown[]; parts?: Array<{ type: string; text?: string }> };
export function sanitizeForUpstream<T extends LooseMessage>(messages: T[]): T[] {
  return messages.filter((m) => {
    if (m.role !== "assistant") return true;
    const content = String(m.content || "").trim();
    const partText = Array.isArray(m.parts)
      ? m.parts.filter((p) => p.type === "text").map((p) => p.text || "").join("").trim()
      : "";
    const hasArtPart = Array.isArray(m.parts) && m.parts.some((p) => p.type === "artifact");
    const hasArt = hasArtPart || (Array.isArray(m.artifacts) && m.artifacts.length > 0);
    return content.length > 0 || partText.length > 0 || hasArt;
  });
}
