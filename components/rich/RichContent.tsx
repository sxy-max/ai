"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import { normalizeMathDelimiters } from "../../lib/math";

/**
 * Go AI 统一 Rich Content Renderer。
 *
 * Chat / Task Result / Markdown Artifact / Project Result 全部走这一个渲染路径，
 * 保证同一份 AI Markdown 在三个入口表现一致：
 *   - react-markdown + GFM（表格/任务列表）+ math + Katex + 代码高亮
 *   - 默认渲染模式；raw Markdown 只作为「原文模式」（二级操作）
 *   - 代码块一键复制；可选整段复制
 *   - 不执行 raw HTML（react-markdown 默认跳过），安全边界不依赖 dangerouslySetInnerHTML
 */
export type RichContentProps = {
  content: string;
  /** 追加到根容器的 className（如 "rich-bubble"），视觉样式由 .rich-content 提供。 */
  className?: string;
  /** 显示「查看原文/查看渲染」切换（默认关闭）。 */
  rawToggle?: boolean;
  /** 显示整段复制按钮（默认关闭）。 */
  copyButton?: boolean;
};

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

export default function RichContent({ content, className, rawToggle, copyButton }: RichContentProps) {
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const md = {
    remarkPlugins: [remarkGfm, remarkMath],
    rehypePlugins: [[rehypeKatex, { throwOnError: false }], rehypeHighlight] as any,
    components: mdComponents,
  };

  const onCopyAll = async () => {
    await copyText(content || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const rootClass = ["rich-content", className].filter(Boolean).join(" ");

  return (
    <div className={rootClass}>
      {rawToggle && (
        <button className="rich-raw-toggle" onClick={() => setRaw((x) => !x)}>
          {raw ? "查看渲染" : "查看原文"}
        </button>
      )}
      {raw ? (
        <pre className="rich-raw">{content || ""}</pre>
      ) : (
        <ReactMarkdown {...md}>{normalizeMathDelimiters(content || "")}</ReactMarkdown>
      )}
      {copyButton && (
        <button className="msg-copy" onClick={onCopyAll}>{copied ? "已复制 ✓" : "复制"}</button>
      )}
    </div>
  );
}
