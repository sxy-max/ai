/** Workspace 元数据 —— 目录结构约定、workspace.json 读写、默认限额。 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LIMITS } from "./types";
import type { WorkspaceDirs, WorkspaceLimits, WorkspaceMeta } from "./types";

export const META_FILE = "workspace.json";
export const INTERNAL_DIR = ".go-ai";
export const INPUT_DIR = "input";
export const VISION_DIR = "vision";
export const WORKING_DIR = "working";
export const OUTPUT_DIR = "output";
export const ARTIFACTS_DIR = "artifacts";
export const TASK_DIR = "task";
export const LOGS_DIR = "logs";
export const AGENT_DIR = "agent";
export const VERIFICATION_DIR = "verification";

/** 目录语义（稳定契约，Agent 只在这些目录内工作）：
 *  task/   任务说明与上下文（task.json/task.md/context.json）
 *  input/  用户上传的原始文件（只读语义，Agent 不应改写）
 *  vision/ 视觉预处理产物（vision.json/reference.md）
 *  working/ Agent 可编辑的工作副本
 *  output/ 最终交付文件（Agent 产出到此）
 *  artifacts/ 产物清单
 *  logs/   结构化执行日志
 *  .go-ai/ 内部元数据（v7 兼容）
 */
export function buildDirs(root: string): WorkspaceDirs {
  return {
    root,
    input: path.join(root, INPUT_DIR),
    vision: path.join(root, VISION_DIR),
    working: path.join(root, WORKING_DIR),
    output: path.join(root, OUTPUT_DIR),
    artifacts: path.join(root, ARTIFACTS_DIR),
    task: path.join(root, TASK_DIR),
    logs: path.join(root, LOGS_DIR),
    agent: path.join(root, AGENT_DIR),
    verification: path.join(root, VERIFICATION_DIR),
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
