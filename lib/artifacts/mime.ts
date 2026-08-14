import type { ArtifactKind } from "./types";

const KIND_MIME: Record<ArtifactKind, string> = {
  html: "text/html",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  txt: "text/plain",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  image: "image/png",
  zip: "application/zip",
  code: "text/plain",
  unknown: "application/octet-stream",
};

const EXT_MIME: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  txt: "text/plain",
  text: "text/plain",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  js: "text/javascript",
  mjs: "text/javascript",
  jsx: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  css: "text/css",
  py: "text/x-python",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  yaml: "text/yaml",
  yml: "text/yaml",
  xml: "text/xml",
  sql: "text/x-sql",
  woff2: "font/woff2",
};

const EXT_KIND: Record<string, ArtifactKind> = {
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  csv: "csv",
  json: "json",
  txt: "txt",
  text: "txt",
  pptx: "pptx",
  xlsx: "xlsx",
  docx: "docx",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  zip: "zip",
  js: "code",
  mjs: "code",
  jsx: "code",
  ts: "code",
  tsx: "code",
  css: "code",
  py: "code",
  sh: "code",
  bash: "code",
  yaml: "code",
  yml: "code",
  xml: "code",
  sql: "code",
};

export function extOf(name: string): string {
  const base = String(name || "").split(/[?#]/)[0];
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function mimeFromFilename(name: string): string {
  const ext = extOf(name);
  return (ext && EXT_MIME[ext]) || "application/octet-stream";
}

export function mimeFromKind(kind: ArtifactKind): string {
  return KIND_MIME[kind] || "application/octet-stream";
}

export function kindFromFilename(name: string, mime?: string): ArtifactKind {
  const ext = extOf(name);
  if (ext && EXT_KIND[ext]) return EXT_KIND[ext];
  if (mime) {
    if (mime.startsWith("text/html")) return "html";
    if (mime.startsWith("text/markdown")) return "markdown";
    if (mime.includes("csv")) return "csv";
    if (mime.includes("json")) return "json";
    if (mime.includes("pptx")) return "pptx";
    if (mime.includes("zip")) return "zip";
    if (mime.startsWith("text/")) return "txt";
  }
  return "unknown";
}
