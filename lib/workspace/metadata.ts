/** Workspace 元数据 —— 目录结构约定、workspace.json 读写、默认限额。 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LIMITS } from "./types";
import type { WorkspaceDirs, WorkspaceLimits, WorkspaceMeta } from "./types";

export const META_FILE = "workspace.json";
export const INTERNAL_DIR = ".go-ai";
export const INPUT_DIR = "input";
export const OUTPUT_DIR = "output";
export const ARTIFACTS_DIR = "artifacts";
export const TASK_DIR = "task";

export function buildDirs(root: string): WorkspaceDirs {
  return {
    root,
    input: path.join(root, INPUT_DIR),
    output: path.join(root, OUTPUT_DIR),
    artifacts: path.join(root, ARTIFACTS_DIR),
    task: path.join(root, TASK_DIR),
    internal: path.join(root, INTERNAL_DIR),
  };
}

export function mergeLimits(overrides?: Partial<WorkspaceLimits>): WorkspaceLimits {
  return { ...DEFAULT_LIMITS, ...(overrides || {}) };
}

export function metaPath(root: string): string {
  return path.join(root, META_FILE);
}

export function writeMeta(meta: WorkspaceMeta): void {
  fs.mkdirSync(meta.root, { recursive: true });
  fs.writeFileSync(metaPath(meta.root), JSON.stringify(meta, null, 2));
}

export function readMeta(root: string): WorkspaceMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath(root), "utf8"));
    return raw && typeof raw.root === "string" ? raw as WorkspaceMeta : null;
  } catch {
    return null;
  }
}

export function isInternalRelPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  return p === INTERNAL_DIR || p.startsWith(INTERNAL_DIR + "/") || p === META_FILE;
}
