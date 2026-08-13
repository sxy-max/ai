"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import { normalizeMathDelimiters } from "../../lib/math";
import { fmtSize } from "../../lib/job/ui";
import type { JobState } from "../../lib/job/ui";
import JobCard from "../job/JobCard";
import ArtifactCard from "../artifact/ArtifactCard";

// 统一的 message 渲染: user 与 assistant 共用, 仅 variant 区分视觉
// 渲染: reasoning(折叠) + content(markdown+katex+highlight) + job(任务状态卡) + artifacts(卡片) + attachments(chips)
// 代码块: 语法高亮(rehype-highlight) + 一键复制

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

async function copyText(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return; }
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch {}
  document.body.removeChild(ta);
}

function CodeBlock({ children, ...props }: any) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    await copyText(ref.current?.textContent || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return <div className="code-wrap"><button className="code-copy" onClick={onCopy}>{copied ? "已复制 ✓" : "复制"}</button><pre {...props} ref={ref}>{children}</pre></div>;
}

const mdComponents = {
  a: (props: any) => <a {...props} target="_blank" rel="noreferrer" />,
  pre: CodeBlock,
};

export default function MessageParts({ message, busy }: { message: MessageLike; busy?: boolean }) {
  const isUser = message.role === "user";
  const md = {
    remarkPlugins: [remarkGfm, remarkMath],
    rehypePlugins: [[rehypeKatex, { throwOnError: false }], rehypeHighlight] as any,
    components: mdComponents,
  };
  return (
    <div className={isUser ? "msg-parts user" : "msg-parts assistant"}>
      {message.reasoning ? (
        <details className="reasoning">
          <summary>思考过程 <span>已完成</span></summary>
          <div><ReactMarkdown {...md}>{normalizeMathDelimiters(message.reasoning)}</ReactMarkdown></div>
        </details>
      ) : null}

      {message.job ? <JobCard job={message.job} /> : null}

      <div className="msg-text">
        <ReactMarkdown {...md}>
          {normalizeMathDelimiters(message.content) || (busy ? "▍" : "")}
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
          {message.artifacts.map((a) => <ArtifactCard key={a.id} a={a} />)}
        </div>
      ) : null}
    </div>
  );
}
