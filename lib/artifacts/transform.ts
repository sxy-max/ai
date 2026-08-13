// 内容 → Artifact 转换（纯函数，可单测，不依赖 Node）。
// 旧 lib/message/transform 的入口由本模块提供（lib/message/transform.ts 只做再导出）。
import type { ArtifactKind } from "./types";
import { mimeFromFilename } from "./mime";

export type HtmlArtifact = { name: string; mime: string; content: string };
export type TransformResult = { content: string; artifact: HtmlArtifact };
export type ArtifactRequest = { kind: ArtifactKind; filename: string; mime: string; content: string };
export type TransformAllResult = { content: string; artifacts: HtmlArtifact[] };
export type TransformContentResult = { content: string; requests: ArtifactRequest[] };

export function findHtmlBlock(content: string): { code: string; start: number; end: number } | null {
  const re = /```\s*html\s*\r?\n([\s\S]*?)(?:```|$)/i;
  const m = re.exec(content);
  if (!m) return null;
  return { code: m[1].replace(/\n$/, ""), start: m.index, end: m.index + m[0].length };
}

export function shouldFileHtml(code: string, explicit: boolean): boolean {
  return explicit || code.split("\n").length > 100;
}

/** 把 assistant content 中第一个超限 HTML block 替换为摘要 + 返回 artifact。无则返回 null。 */
export function transformHtmlToArtifact(content: string, explicit: boolean): TransformResult | null {
  const block = findHtmlBlock(content);
  if (!block) return null;
  if (!shouldFileHtml(block.code, explicit)) return null;
  const lines = block.code.split("\n").length;
  const preview = block.code.split("\n").slice(0, 15).join("\n");
  const replacement = `HTML 已生成，共 ${lines} 行，已转为文件。\n\n\`\`\`html\n${preview}${lines > 15 ? "\n…" : ""}\n\`\`\``;
  const newContent = content.slice(0, block.start) + replacement + content.slice(block.end);
  return { content: newContent, artifact: { name: "webpage.html", mime: "text/html", content: block.code } };
}

/** 处理 content 中所有超限 HTML block（多个时按出现顺序编号文件名）。 */
export function transformAllHtml(content: string, explicit: boolean): TransformAllResult {
  const re = /```\s*html\s*\r?\n([\s\S]*?)(?:```|$)/gi;
  const blocks: { code: string; start: number; end: number }[] = [];
  let m;
  while ((m = re.exec(content))) {
    const code = m[1].replace(/\n$/, "");
    if (shouldFileHtml(code, explicit)) {
      blocks.push({ code, start: m.index, end: m.index + m[0].length });
    }
  }
  const artifacts: HtmlArtifact[] = [];
  let current = content;
  // 从后往前替换，保持 start/end 有效；避免替换后生成的预览块被再次匹配。
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    const lines = b.code.split("\n").length;
    const preview = b.code.split("\n").slice(0, 15).join("\n");
    const name = i === 0 ? "webpage.html" : `webpage-${i + 1}.html`;
    const replacement = `HTML 已生成，共 ${lines} 行，已转为文件。\n\n\`\`\`html\n${preview}${lines > 15 ? "\n…" : ""}\n\`\`\``;
    current = current.slice(0, b.start) + replacement + current.slice(b.end);
    artifacts.unshift({ name, mime: "text/html", content: b.code });
  }
  return { content: current, artifacts };
}

const LANG_EXT: Record<string, string> = {
  js: "js",
  jsx: "jsx",
  ts: "ts",
  tsx: "tsx",
  css: "css",
  json: "json",
  csv: "csv",
  sql: "sql",
  xml: "xml",
  py: "py",
  python: "py",
  sh: "sh",
  bash: "sh",
  yaml: "yml",
  yml: "yml",
  md: "md",
  markdown: "md",
};

/** 明确文件请求（explicit）时，超长非 HTML 代码块也转为 Artifact。 */
export function transformContent(content: string, explicit: boolean): TransformContentResult {
  const html = transformAllHtml(content, explicit);
  const requests: ArtifactRequest[] = html.artifacts.map((a) => ({
    kind: "html",
    filename: a.name,
    mime: a.mime,
    content: a.content,
  }));
  if (!explicit) return { content: html.content, requests };

  const re = /```\s*([a-zA-Z0-9_+.-]+)\s*\r?\n([\s\S]*?)(?:```|$)/gi;
  const blocks: { lang: string; code: string; start: number; end: number }[] = [];
  let m;
  while ((m = re.exec(html.content))) {
    const lang = m[1].toLowerCase();
    if (lang === "html" || lang === "htm") continue;
    const code = m[2].replace(/\n$/, "");
    if (code.split("\n").length > 100) {
      blocks.push({ lang, code, start: m.index, end: m.index + m[0].length });
    }
  }
  const codeRequests: ArtifactRequest[] = [];
  let current = html.content;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    const lines = b.code.split("\n").length;
    const preview = b.code.split("\n").slice(0, 15).join("\n");
    const ext = LANG_EXT[b.lang] || "txt";
    const filename = `code-${i + 1}.${ext}`;
    const kind: ArtifactKind = ext === "json" ? "json" : ext === "csv" ? "csv" : ext === "md" ? "markdown" : "code";
    const replacement = `代码已生成，共 ${lines} 行，已转为文件。\n\n\`\`\`${b.lang}\n${preview}${lines > 15 ? "\n…" : ""}\n\`\`\``;
    current = current.slice(0, b.start) + replacement + current.slice(b.end);
    codeRequests.unshift({ kind, filename, mime: mimeFromFilename(filename), content: b.code });
  }
  return { content: current, requests: [...requests, ...codeRequests] };
}
