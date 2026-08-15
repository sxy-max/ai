/**
 * Workspace Manifest（V1.3 WP15）：每个 workspace 的清单。
 * 记录 path/size/sha256/mime/role/version/createdBy/modifiedBy；
 * role: input / working / output / artifact / system。
 * Agent 不再"自己猜目录里哪个文件重要"；Planner 可读 workspace summary。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { walkWorkspace } from "./safety";

export type WorkspaceFileRole = "input" | "working" | "output" | "artifact" | "system";

export type WorkspaceManifestEntry = {
  path: string;
  size: number;
  sha256: string;
  mime: string;
  role: WorkspaceFileRole;
  version: number;
  createdBy: string;
  modifiedBy: string;
  modifiedAt: number;
};

export type WorkspaceManifest = {
  workspaceId: string;
  version: number;
  createdAt: number;
  files: WorkspaceManifestEntry[];
};

function roleOf(relPath: string): WorkspaceFileRole {
  const p = relPath.replace(/\\/g, "/");
  if (p === "input" || p.startsWith("input/")) return "input";
  if (p === "working" || p.startsWith("working/")) return "working";
  if (p === "output" || p.startsWith("output/")) return "output";
  if (p === "artifacts" || p.startsWith("artifacts/")) return "artifact";
  return "system";
}

function mimeOf(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html", ".htm": "text/html", ".md": "text/markdown", ".txt": "text/plain",
    ".csv": "text/csv", ".json": "application/json", ".zip": "application/zip",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pdf": "application/pdf",
  };
  return map[ext] || "application/octet-stream";
}

const MANIFEST_DIR = ".go-ai";
const MANIFEST_FILE = "workspace-manifest.json";

/** 生成 workspace 清单（跳过内部目录）。 */
export function buildWorkspaceManifest(workspaceRoot: string, version = 1, actor = "system"): WorkspaceManifest {
  const files: WorkspaceManifestEntry[] = [];
  for (const f of walkWorkspace(workspaceRoot)) {
    if (f.isLink) continue;
    if (f.relPath.startsWith(".go-ai/") || f.relPath === "workspace.json") continue;
    const buf = fs.readFileSync(f.absPath);
    files.push({
      path: f.relPath.replace(/\\/g, "/"),
      size: buf.length,
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      mime: mimeOf(f.absPath),
      role: roleOf(f.relPath),
      version,
      createdBy: actor,
      modifiedBy: actor,
      modifiedAt: Date.now(),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { workspaceId: path.basename(workspaceRoot), version, createdAt: Date.now(), files };
}

/** 落盘 manifest（.go-ai/workspace-manifest.json）。 */
export function writeWorkspaceManifest(workspaceRoot: string, manifest: WorkspaceManifest): void {
  const dir = path.join(workspaceRoot, MANIFEST_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

/** 读取 manifest；不存在返回 null。 */
export function readWorkspaceManifest(workspaceRoot: string): WorkspaceManifest | null {
  try {
    const raw = fs.readFileSync(path.join(workspaceRoot, MANIFEST_DIR, MANIFEST_FILE), "utf8");
    return JSON.parse(raw) as WorkspaceManifest;
  } catch {
    return null;
  }
}

/** 按 role 过滤清单（Planner/Agent 上下文用）。 */
export function manifestSummary(manifest: WorkspaceManifest | null, roles: WorkspaceFileRole[] = ["input", "working", "output", "artifact"]): string {
  if (!manifest) return "";
  const lines: string[] = [];
  for (const role of roles) {
    const files = manifest.files.filter((f) => f.role === role);
    if (!files.length) continue;
    lines.push(`${role}/: ${files.map((f) => `${f.path.replace(`${role}/`, "")} (${f.size}B)`).join(", ")}`);
  }
  return lines.join("；");
}

/** 检测文件是否变化（对比 manifest sha256）。 */
export function fileChangedSince(workspaceRoot: string, relPath: string, manifest: WorkspaceManifest | null): boolean {
  if (!manifest) return true;
  const entry = manifest.files.find((f) => f.path === relPath.replace(/\\/g, "/"));
  if (!entry) return true;
  try {
    const buf = fs.readFileSync(path.join(workspaceRoot, relPath));
    return crypto.createHash("sha256").update(buf).digest("hex") !== entry.sha256;
  } catch {
    return true;
  }
}
