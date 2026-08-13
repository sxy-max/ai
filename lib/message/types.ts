// Message 领域类型: parts 判别联合, reasoning 与 text 平级分离
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; status: "streaming" | "complete" }
  | { type: "artifact"; artifactId: string; name: string; mime: string; size: number }
  | { type: "attachment"; attachmentId: string; name: string; kind: "text" | "image" }
  | { type: "tool_status"; name: string; status: string };

export type MessageStatus = "streaming" | "complete" | "incomplete" | "failed";

export type Message = {
  id: string;
  role: "user" | "assistant";
  status: MessageStatus;
  parts: MessagePart[];
  createdAt: number;
  /** 兼容旧字段: content 是 text parts 的拼接(仅兼容, 新写入用 parts) */
  content?: string;
  /** 兼容旧字段: reasoning 是独立 part, 绝不并进 content */
  reasoning?: string;
};

export function textOf(m: Message): string {
  return m.parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export function reasoningOf(m: Message): string {
  return m.parts
    .filter((p): p is Extract<MessagePart, { type: "reasoning" }> => p.type === "reasoning")
    .map((p) => p.text)
    .join("");
}

export function hasArtifact(m: Message): boolean {
  return m.parts.some((p) => p.type === "artifact");
}

export function isUsableForUpstream(m: Message): boolean {
  // assistant 必须有 text 或 artifact; 纯 reasoning 不算可用正文
  if (m.role === "assistant") {
    return textOf(m).trim().length > 0 || hasArtifact(m);
  }
  return true;
}

/** 创建一条完整 assistant message(parts 结构) */
export function createMessage(
  id: string,
  role: "user" | "assistant",
  parts: MessagePart[],
  status: MessageStatus = "complete",
): Message {
  return { id, role, status, parts, createdAt: Date.now() };
}
