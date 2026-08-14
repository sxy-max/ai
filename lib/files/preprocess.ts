/**
 * FilePreprocessor（V1.1 WP9）：文件理解层。
 * 不把所有文件原样丢给 LLM——统一产出 FileContext（结构化摘要），供 Planner 与上下文使用。
 * Agent 仍可读取原文件（workspace/input/）。
 */

import path from "node:path";

export type FileContext = {
  type: "markdown" | "text" | "csv" | "json" | "html" | "zip" | "image" | "code" | "other";
  filename: string;
  mime: string;
  size: number;
  /** 结构化信息（按类型不同）。 */
  structure: Record<string, unknown>;
  /** 文本预览（≤1200 字符）。 */
  textPreview: string;
  metadata: Record<string, unknown>;
};

const MAX_PREVIEW = 1200;

export function detectType(filename: string, mime: string): FileContext["type"] {
  const ext = path.extname(filename).toLowerCase();
  if (/\.(md|markdown)$/.test(ext)) return "markdown";
  if (/\.(txt|text)$/.test(ext)) return "text";
  if (/\.csv$/.test(ext)) return "csv";
  if (/\.json$/.test(ext)) return "json";
  if (/\.(html?|xhtml)$/.test(ext)) return "html";
  if (/\.zip$/.test(ext)) return "zip";
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/.test(ext)) return "image";
  if (mime.startsWith("image/")) return "image";
  if (/\.(js|ts|tsx|jsx|py|go|rs|java|c|h|cpp|sh|yaml|yml|xml|css)$/.test(ext)) return "code";
  if (/\.(xlsx|xls|docx|pptx|pdf)$/.test(ext)) return "other"; // 二进制 Office/PDF（adapter 结构预留）
  return "other";
}

export async function preprocessFile(buf: Buffer, filename: string, mime = ""): Promise<FileContext> {
  const type = detectType(filename, mime);
  const base: Omit<FileContext, "structure" | "textPreview"> = {
    type, filename, mime: mime || "application/octet-stream", size: buf.length, metadata: {}
  };

  switch (type) {
    case "csv": {
      const text = buf.toString("utf8");
      const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(",").map((c) => c.trim()));
      const columns = rows[0] || [];
      return {
        ...base,
        structure: { columns, rowCount: Math.max(0, rows.length - 1), sampleRows: rows.slice(1, 4) },
        textPreview: text.slice(0, MAX_PREVIEW)
      };
    }
    case "json": {
      const text = buf.toString("utf8");
      let structure: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(text);
        structure = Array.isArray(parsed) ? { arrayLength: parsed.length, firstItem: parsed[0] } : { keys: Object.keys(parsed).slice(0, 20) };
      } catch {
        structure = { error: "JSON 解析失败" };
      }
      return { ...base, structure, textPreview: text.slice(0, MAX_PREVIEW) };
    }
    case "html": {
      const text = buf.toString("utf8");
      const title = text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || "";
      const headings = (text.match(/<h[1-6][^>]*>[^<]*<\/h[1-6]>/gi) || []).slice(0, 10).map((h) => h.replace(/<[^>]+>/g, "").trim());
      const links = (text.match(/href=["']([^"']+)["']/gi) || []).slice(0, 10).map((a) => a.replace(/href=["']|["']/g, ""));
      return {
        ...base,
        structure: { title, headings, links, hasStyle: /<style/i.test(text), hasScript: /<script/i.test(text) },
        textPreview: text.slice(0, MAX_PREVIEW)
      };
    }
    case "zip": {
      const JSZip = (await import("jszip")).default;
      let fileTree: string[] = [];
      try {
        const zip = await JSZip.loadAsync(buf);
        fileTree = Object.keys(zip.files).slice(0, 100);
      } catch {
        fileTree = [];
      }
      return { ...base, structure: { fileTree, entryCount: fileTree.length }, textPreview: "" };
    }
    case "image": {
      return { ...base, structure: { note: "图片内容由 VisionPreprocessor 处理（workspace/vision/）" }, textPreview: "（图片）" };
    }
    case "markdown": {
      const text = buf.toString("utf8");
      const headings = (text.match(/^#{1,6}\s+.+$/gm) || []).slice(0, 20);
      return { ...base, structure: { headings }, textPreview: text.slice(0, MAX_PREVIEW) };
    }
    default: {
      const text = buf.toString("utf8");
      return { ...base, structure: {}, textPreview: text.slice(0, MAX_PREVIEW) };
    }
  }
}

/** 批量预处理（任务文件上下文）。 */
export async function preprocessFiles(files: Array<{ filename: string; mime: string; content: Buffer }>): Promise<FileContext[]> {
  const contexts: FileContext[] = [];
  for (const file of files) {
    try {
      contexts.push(await preprocessFile(file.content, file.filename, file.mime));
    } catch {
      contexts.push({
        type: "other", filename: file.filename, mime: file.mime || "application/octet-stream",
        size: file.content.length, structure: {}, textPreview: "", metadata: {}
      });
    }
  }
  return contexts;
}
