/**
 * DocumentAdapter（V1.2 WP17）：文档格式适配层。
 * 目标：用户给文档 → Agent/管线真实读取 → 修改 → 输出新文档。
 * 第一阶段实现 MD/TXT/HTML 真实链；DOCX 下一阶段（见文末方案）。
 */

export type DocumentContext = {
  format: string;
  /** 结构化正文（MD/TXT/HTML 原文或提取文本）。 */
  content: string;
  /** 元数据（标题/结构信息等）。 */
  metadata: Record<string, string>;
};

export interface DocumentAdapter {
  readonly format: string;
  /** 读取文档 → 结构化上下文（供 Planner/Agent context）。 */
  read(buf: Buffer, filename: string): DocumentContext | null;
  /** 写入文档（round-trip；返回新 buffer）。 */
  write(content: string, filename: string): Buffer;
}

/* ---------- 实现 ---------- */

class MarkdownAdapter implements DocumentAdapter {
  readonly format = "markdown";
  read(buf: Buffer, filename: string): DocumentContext | null {
    try {
      const content = buf.toString("utf8");
      const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || filename.replace(/\.[^.]+$/, "");
      return { format: "markdown", content, metadata: { title, headings: (content.match(/^#{1,6}\s+.+$/gm) || []).length.toString() } };
    } catch {
      return null;
    }
  }
  write(content: string, _filename: string): Buffer {
    return Buffer.from(content, "utf8");
  }
}

class TextAdapter implements DocumentAdapter {
  readonly format = "txt";
  read(buf: Buffer, filename: string): DocumentContext | null {
    try {
      const content = buf.toString("utf8");
      return { format: "txt", content, metadata: { title: filename.replace(/\.[^.]+$/, ""), lines: content.split(/\r?\n/).length.toString() } };
    } catch {
      return null;
    }
  }
  write(content: string, _filename: string): Buffer {
    return Buffer.from(content, "utf8");
  }
}

class HtmlAdapter implements DocumentAdapter {
  readonly format = "html";
  read(buf: Buffer, filename: string): DocumentContext | null {
    try {
      const content = buf.toString("utf8");
      const title = content.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || filename.replace(/\.[^.]+$/, "");
      return { format: "html", content, metadata: { title } };
    } catch {
      return null;
    }
  }
  write(content: string, _filename: string): Buffer {
    return Buffer.from(content, "utf8");
  }
}

/* ---------- 注册表 ---------- */

const ADAPTERS: DocumentAdapter[] = [new MarkdownAdapter(), new TextAdapter(), new HtmlAdapter()];

export const DOCUMENT_ADAPTERS: Record<string, DocumentAdapter> = Object.fromEntries(ADAPTERS.map((a) => [a.format, a]));

export function documentAdapterFor(filename: string): DocumentAdapter | null {
  const ext = filename.toLowerCase().split(".").pop() || "";
  if (ext === "md" || ext === "markdown") return DOCUMENT_ADAPTERS.markdown;
  if (ext === "txt" || ext === "text") return DOCUMENT_ADAPTERS.txt;
  if (ext === "html" || ext === "htm") return DOCUMENT_ADAPTERS.html;
  return null;
}

/**
 * DOCX 下一阶段方案（本轮不阻塞）：
 * - 依赖：现有 docx 包（生成已用）仅支持写；读需 mammoth（docx → HTML/文本）或 docx4js。
 * - 计划：mammoth.extractRawText + docx 包重建（格式保持有限：标题/段落/粗斜体）；
 *   DocumentAdapter 增加 "docx" 实现（read：mammoth → content；write：docx 包 → buffer）。
 * - 接入点：documentAdapterFor 增加 docx 分支；fileSummaries 对 .docx 输出结构摘要。
 * - 验收：文档往返（内容不丢）+ 产物 validator（docx ZIP 容器 + word/document.xml 存在）。
 */
