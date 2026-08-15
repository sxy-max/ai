/**
 * FileIngestionPipeline（V1.3 WP16）：统一文件解析。
 * PNG/PDF/MD/TXT/HTML/CSV/XLSX/ZIP → FileDescriptor
 * （path/type/mime/size/sha256/extractedText/visionContext/archiveManifest）。
 * 不再让各 route 自己解析。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { safeExtractZip } from "../workspace/zip";
import type { WorkspaceLimits } from "../workspace/types";

export type FileDescriptor = {
  path: string;
  type: "image" | "pdf" | "markdown" | "text" | "html" | "csv" | "xlsx" | "zip" | "json" | "other";
  mime: string;
  size: number;
  sha256: string;
  extractedText?: string;
  visionContext?: boolean;
  archiveManifest?: string[];
};

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain",
  ".html": "text/html", ".htm": "text/html", ".csv": "text/csv", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip", ".json": "application/json",
};

export function typeOf(filename: string): FileDescriptor["type"] {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".zip") return "zip";
  if (ext === ".pdf") return "pdf";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".txt" || ext === ".text") return "text";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".csv") return "csv";
  if (ext === ".xlsx") return "xlsx";
  if (ext === ".json") return "json";
  if (MIME[ext]?.startsWith("image/")) return "image";
  return "other";
}

const TEXT_MAX = 200_000;

/** 文本类文件提取（UTF-8 安全：含 NUL 按二进制跳过）。 */
function extractText(buf: Buffer, type: FileDescriptor["type"]): string | undefined {
  if (type === "image" || type === "pdf" || type === "zip" || type === "xlsx") return undefined;
  const head = buf.subarray(0, 512);
  if (head.includes(0)) return undefined;
  return buf.subarray(0, TEXT_MAX).toString("utf8");
}

/** 解析单个文件 buffer → FileDescriptor。 */
export function ingestFileBuffer(filename: string, buf: Buffer, options?: { workspaceLimits?: WorkspaceLimits }): FileDescriptor {
  const type = typeOf(filename);
  const descriptor: FileDescriptor = {
    path: filename,
    type,
    mime: MIME[path.extname(filename).toLowerCase()] || "application/octet-stream",
    size: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  };
  const text = extractText(buf, type);
  if (text !== undefined) descriptor.extractedText = text;
  if (type === "image") descriptor.visionContext = true;
  return descriptor;
}

/** 从文件路径解析（读盘后调 ingestFileBuffer）。 */
export function ingestFile(filePath: string): FileDescriptor | null {
  try {
    const buf = fs.readFileSync(filePath);
    return ingestFileBuffer(path.basename(filePath), buf);
  } catch {
    return null;
  }
}

/** ZIP 归档清单（安全解压到临时目录后枚举；失败返回 null）。 */
export async function ingestZipArchive(buf: Buffer, limits?: WorkspaceLimits): Promise<FileDescriptor | null> {
  const descriptor = ingestFileBuffer("archive.zip", buf, { workspaceLimits: limits });
  if (descriptor.type !== "zip") return null;
  try {
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goai-ingest-"));
    try {
      const extracted = await safeExtractZip(buf, tmp, limits || { maxFileSize: 50 * 1024 * 1024, maxTotalSize: 200 * 1024 * 1024, maxFiles: 10_000, maxDepth: 10 });
      descriptor.archiveManifest = extracted.slice(0, 500);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch {
    descriptor.archiveManifest = ["（解压失败：可能为损坏或超限归档）"];
  }
  return descriptor;
}

/** 文件清单摘要（Planner/Agent 上下文）。 */
export function descriptorsSummary(descriptors: FileDescriptor[]): string {
  return descriptors.map((d) => {
    const parts = [`- ${d.path}（${d.type}，${d.size}B）`];
    if (d.type === "csv" && d.extractedText) parts.push(`\n  内容预览：${d.extractedText.slice(0, 300).replace(/\s+/g, " ")}`);
    if (d.type === "markdown" || d.type === "text" || d.type === "html") parts.push(`\n  文本摘要：${(d.extractedText || "").slice(0, 200).replace(/\s+/g, " ")}`);
    if (d.type === "zip" && d.archiveManifest) parts.push(`\n  归档：${d.archiveManifest.length} 个文件（${d.archiveManifest.slice(0, 8).join("、")}…）`);
    if (d.visionContext) parts.push("\n  （图片：需视觉预处理）");
    return parts.join("");
  }).join("\n");
}
