/**
 * Workspace Snapshot（V1.3 WP14）：版本快照 + rollback。
 * 时机：before-job / after-step-N / before-repair / completed。
 * 实现：增量复制 working/output 到 .go-ai/snapshots/{snapId}/ + manifest（sha256）。
 * 支持 rollback step：Agent 改坏文件 → validator fail → restore before-step → repair。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildWorkspaceManifest, readWorkspaceManifest, writeWorkspaceManifest } from "./manifest";

const SNAP_DIR = ".go-ai/snapshots";

export type WorkspaceSnapshot = {
  id: string;
  label: string;
  createdAt: number;
  files: Array<{ path: string; size: number; sha256: string }>;
};

function snapRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, SNAP_DIR);
}

/** 创建快照（working/output 增量复制 + sha256 manifest）。label: before-job/after-step-N/before-repair/completed。 */
export function createWorkspaceSnapshot(workspaceRoot: string, label: string): WorkspaceSnapshot | null {
  try {
    const dir = snapRoot(workspaceRoot);
    fs.mkdirSync(dir, { recursive: true });
    const id = `snap-${label}-${Date.now()}`;
    const target = path.join(dir, id);
    fs.mkdirSync(target, { recursive: true });
    const files: WorkspaceSnapshot["files"] = [];
    for (const area of ["working", "output"]) {
      const src = path.join(workspaceRoot, area);
      if (!fs.existsSync(src)) continue;
      const walk = (dirPath: string, prefix: string) => {
        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(dirPath, entry.name), rel);
          else {
            const buf = fs.readFileSync(path.join(dirPath, entry.name));
            const flat = rel.replace(/[\/\\]/g, "_");
            fs.copyFileSync(path.join(dirPath, entry.name), path.join(target, flat));
            files.push({ path: rel, size: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") });
          }
        }
      };
      walk(src, area);
    }
    fs.writeFileSync(path.join(target, "snapshot.json"), JSON.stringify({ id, label, createdAt: Date.now(), files }, null, 2));
    return { id, label, createdAt: Date.now(), files };
  } catch {
    return null;
  }
}

/** 列出可用快照。 */
export function listWorkspaceSnapshots(workspaceRoot: string): WorkspaceSnapshot[] {
  try {
    const dir = snapRoot(workspaceRoot);
    if (!fs.existsSync(dir)) return [];
    const snaps: WorkspaceSnapshot[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, entry.name, "snapshot.json"), "utf8");
        snaps.push(JSON.parse(raw) as WorkspaceSnapshot);
      } catch {}
    }
    return snaps.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/** 还原快照（working/output 覆盖；保留 input 与 .go-ai）。返回还原文件数。 */
export function restoreWorkspaceSnapshot(workspaceRoot: string, snapshotId: string): number {
  const snapDir = path.join(snapRoot(workspaceRoot), snapshotId);
  const metaPath = path.join(snapDir, "snapshot.json");
  if (!fs.existsSync(metaPath)) return 0;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as WorkspaceSnapshot;
  let restored = 0;
  for (const file of meta.files) {
    const parts = file.path.split("/");
    const area = parts[0];
    const rel = parts.slice(1).join("/");
    const destDir = path.join(workspaceRoot, area);
    const dest = path.join(destDir, rel);
    if (!dest.startsWith(workspaceRoot + path.sep)) continue;
    const src = path.join(snapDir, file.path.replace(/[\/\\]/g, "_"));
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    restored++;
  }
  return restored;
}

/** 清理快照目录。 */
export function cleanupWorkspaceSnapshots(workspaceRoot: string): void {
  try {
    fs.rmSync(snapRoot(workspaceRoot), { recursive: true, force: true });
  } catch {}
}

/** 便捷：before-repair 快照 + 失败后还原（devExecutor repair 循环用）。 */
export function snapshotBeforeRepair(workspaceRoot: string): string | null {
  return createWorkspaceSnapshot(workspaceRoot, "before-repair")?.id || null;
}

export { buildWorkspaceManifest, readWorkspaceManifest, writeWorkspaceManifest };
