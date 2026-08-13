/** File Processor —— 上传文件类型识别 + workspace manifest 登记。 */

import fs from "node:fs";
import path from "node:path";
import type { WorkspaceManager } from "../workspace/service";
import type { WorkspaceFileInfo } from "../workspace/types";

export type FileKind =
  | "markdown"
  | "csv"
  | "json"
  | "html"
  | "css"
  | "js"
  | "image"
  | "zip"
  | "binary"
  | "text";

export type ManifestEntry = {
  relPath: string;
  name: string;
  size: number;
  kind: FileKind;
  area: WorkspaceFileInfo["area"];
};

export type WorkspaceManifest = {
  version: 1;
  updatedAt: number;
  files: ManifestEntry[];
};

export const MANIFEST_RELPATH = ".go-ai/manifest.json";

const EXT_KIND: Record<string, FileKind> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".csv": "csv",
  ".json": "json",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".ts": "js",
  ".tsx": "js",
  ".jsx": "js",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".svg": "image",
  ".zip": "zip",
  ".txt": "text",
  ".log": "text",
  ".py": "text",
  ".sh": "text",
  ".yaml": "text",
  ".yml": "text",
  ".xml": "text",
};

const BINARY_EXT = new Set([
  ".pdf", ".docx", ".xlsx", ".pptx", ".bin", ".exe", ".dll", ".so", ".dylib", ".wasm", ".gz", ".tar",
]);

/** 依据扩展名识别文件类型。未知扩展名按是否疑似二进制分类。 */
export function detectFileKind(relPath: string): FileKind {
  const ext = path.extname(relPath).toLowerCase();
  const fromExt = EXT_KIND[ext];
  if (fromExt) return fromExt;
  return BINARY_EXT.has(ext) ? "binary" : "text";
}

/** 扫描 workspace 用户文件（排除内部元数据），登记 .go-ai/manifest.json。返回清单。 */
export function registerWorkspaceManifest(ws: WorkspaceManager): WorkspaceManifest {
  const files = ws
    .listWorkspaceFiles()
    .filter((f) => f.area !== "internal")
    .map((f) => ({
      relPath: f.relPath,
      name: path.basename(f.relPath),
      size: f.size,
      kind: detectFileKind(f.relPath),
      area: f.area,
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
  const manifest: WorkspaceManifest = { version: 1, updatedAt: Date.now(), files };
  fs.mkdirSync(path.join(ws.root, ".go-ai"), { recursive: true });
  fs.writeFileSync(path.join(ws.root, ".go-ai", "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** 读取 workspace manifest；不存在或损坏返回 null。 */
export function readWorkspaceManifest(ws: WorkspaceManager): WorkspaceManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ws.root, ".go-ai", "manifest.json"), "utf8"));
    return raw && Array.isArray(raw.files) ? (raw as WorkspaceManifest) : null;
  } catch {
    return null;
  }
}
