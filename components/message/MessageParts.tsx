"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

// 统一的 message 渲染: user 与 assistant 共用, 仅 variant 区分视觉
// 渲染: reasoning(折叠) + content(markdown+katex) + artifacts(卡片) + attachments(chips)

export type MessageLike = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  artifacts?: { id: string; name: string; mime: string; size: number; downloadUrl: string }[];
  attachments?: { id: string; name: string; kind: "text" | "image"; compressed?: boolean; originalChars?: number }[];
  status?: string;
};

export function fmtSize(b: number) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

export default function MessageParts({ message, busy }: { message: MessageLike; busy?: boolean }) {
  const isUser = message.role === "user";
  const md = {
    remarkPlugins: [remarkGfm, remarkMath],
    rehypePlugins: [[rehypeKatex, { throwOnError: false }]] as any,
  };
  return (
    <div className={isUser ? "msg-parts user" : "msg-parts assistant"}>
      {message.reasoning ? (
        <details className="reasoning">
          <summary>思考过程 <span>已完成</span></summary>
          <div><ReactMarkdown {...md}>{message.reasoning}</ReactMarkdown></div>
        </details>
      ) : null}

      <div className="msg-text">
        <ReactMarkdown {...md}>
          {message.content || (busy ? "▍" : "")}
        </ReactMarkdown>
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
          {message.artifacts.map((a) => (
            <div className="artifact-card" data-testid="artifact-card" key={a.id}>
              <div className="artifact-name">{a.name}</div>
              <div className="artifact-meta">{(a.mime.split("/")[1] || a.mime).toUpperCase()} · {fmtSize(a.size)}</div>
              <a className="artifact-dl" href={a.downloadUrl} download>下载</a>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
