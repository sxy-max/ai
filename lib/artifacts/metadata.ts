import { kindFromFilename } from "./mime";
import type { Artifact, ArtifactKind, ArtifactStatus } from "./types";

const KIND_LABEL: Record<ArtifactKind, string> = {
  html: "HTML",
  markdown: "Markdown",
  csv: "CSV",
  json: "JSON",
  txt: "文本",
  pptx: "PPT",
  zip: "ZIP",
  code: "代码",
  unknown: "文件",
};

const KIND_DEFAULT_FILENAME: Record<ArtifactKind, string> = {
  html: "document.html",
  markdown: "document.md",
  csv: "data.csv",
  json: "data.json",
  txt: "document.txt",
  pptx: "slides.pptx",
  zip: "archive.zip",
  code: "code.txt",
  unknown: "file.txt",
};

/** 清洗文件名：去掉路径与非法字符，限制长度，保证可安全落盘 / 用于 content-disposition。 */
export function sanitizeFilename(name: string): string {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const clean = base.replace(/[^\w.\-]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return clean || "file";
}

export function displayLabel(kind: ArtifactKind): string {
  return KIND_LABEL[kind] || "文件";
}

export function defaultFilename(kind: ArtifactKind): string {
  return KIND_DEFAULT_FILENAME[kind] || "file.txt";
}

export function deriveKind(name: string, mime?: string): ArtifactKind {
  return kindFromFilename(name, mime);
}

export function computeExpiry(createdAt: number, ttlMs?: number): number | undefined {
  if (!ttlMs || !(ttlMs > 0)) return undefined;
  return createdAt + ttlMs;
}

export function isExpired(a: { expiresAt?: number }): boolean {
  return typeof a.expiresAt === "number" && a.expiresAt < Date.now();
}

type LegacyManifestEntry = { name?: string; mime?: string; size?: number; createdAt?: number };

/** 把 manifest 条目规范化为完整 Artifact。兼容旧格式 {name,mime,size,createdAt}。 */
export function normalizeArtifact(id: string, raw: Record<string, any>): Artifact {
  const legacy = raw && typeof raw.kind !== "string" ? (raw as LegacyManifestEntry) : null;
  if (legacy) {
    const kind = kindFromFilename(legacy.name || "file", legacy.mime);
    return {
      id,
      kind,
      filename: String(legacy.name || "file"),
      mimeType: String(legacy.mime || "application/octet-stream"),
      size: Number(legacy.size) || 0,
      status: "ready",
      source: "manual_upload",
      createdAt: Number(legacy.createdAt) || 0,
    };
  }
  const statusRaw = (raw?.status as ArtifactStatus) || "ready";
  const status: ArtifactStatus = statusRaw === "expired" ? "expired" : isExpired(raw) ? "expired" : statusRaw;
  return {
    id,
    kind: (raw?.kind as ArtifactKind) || "unknown",
    filename: String(raw?.filename || "file"),
    mimeType: String(raw?.mimeType || "application/octet-stream"),
    size: Number(raw?.size) || 0,
    status,
    source: (raw?.source as Artifact["source"]) || "manual_upload",
    jobId: raw?.jobId,
    messageId: raw?.messageId,
    createdAt: Number(raw?.createdAt) || 0,
    expiresAt: typeof raw?.expiresAt === "number" ? raw.expiresAt : undefined,
    metadata: raw?.metadata,
  };
}
