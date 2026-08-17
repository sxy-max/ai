"use client";

import { fmtSize } from "../../lib/job/ui";
import type { JobState } from "../../lib/job/ui";
import JobCard from "../job/JobCard";
import ArtifactCard from "../artifact/ArtifactCard";
import RichContent from "../rich/RichContent";

// 统一的 message 渲染: user 与 assistant 共用, 仅 variant 区分视觉
// 渲染: reasoning(折叠) + content(统一 RichContent: markdown+katex+highlight) + job(任务状态卡) + artifacts(卡片) + attachments(chips)
// 与 Task Result / Markdown Artifact 共用同一渲染路径，保证一致表现。

export type MessageLike = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  artifacts?: { id: string; name: string; mime: string; size: number; downloadUrl: string; kind?: string; status?: string }[];
  attachments?: { id: string; name: string; kind: "text" | "image"; compressed?: boolean; originalChars?: number }[];
  status?: string;
  job?: JobState;
};

export { fmtSize };

export default function MessageParts({ message, busy }: { message: MessageLike; busy?: boolean }) {
  const isUser = message.role === "user";
  return (
    <div className={isUser ? "msg-parts user" : "msg-parts assistant"}>
      {(message.status === "incomplete" || message.status === "failed") && (
        <div className={`msg-status ${message.status}`}>
          {message.status === "incomplete" ? "模型完成了推理，但未返回最终答案，可重试。" : "回答失败，请重试。"}
        </div>
      )}
      {message.reasoning ? (
        <details className="reasoning">
          <summary>思考过程 <span>已完成</span></summary>
          <div><RichContent content={message.reasoning} /></div>
        </details>
      ) : null}

      {message.job ? <JobCard job={message.job} /> : null}

      <div className="msg-text">
        <RichContent content={message.content || (busy ? "▍" : "")} />
      </div>

      {message.attachments?.length ? (
        <div className="chips">
          {message.attachments.map((a) => (
            <span key={a.id}>{a.kind === "image" ? "▧" : "▤"} {a.name}{a.compressed ? " · 已压缩" : ""}</span>
          ))}
        </div>
      ) : null}

      {message.artifacts?.length ? (
        <div className="artifact-list">
          {message.artifacts.map((a) => <ArtifactCard key={a.id} a={a} />)}
        </div>
      ) : null}
    </div>
  );
}
