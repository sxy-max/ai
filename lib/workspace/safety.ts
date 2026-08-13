/** Workspace 安全校验 —— 路径穿越 / 绝对路径 / symlink 逃逸 / 保留文件名 / 大小数量限额。
 *  本模块是纯函数（无状态、可独立测试），供 Workspace Manager 与 ZIP 解压共用。 */

import fs from "node:fs";
import path from "node:path";
import { isInternalRelPath } from "./metadata";
import type { WorkspaceLimits } from "./types";
import { WorkspaceError } from "./types";

/** 清理相对路径：去 NUL、统一反斜杠为 /、去掉前导 ./ 与 /。返回 posix 风格相对路径。 */
export function normalizeRelPath(relPath: unknown): string {
  let p = String(relPath ?? "").replace(/\0/g, "").replace(/\\/g, "/");
  p = p.replace(/^\.\//, "").replace(/^\/+/, "");
  return p;
}

/** 把相对路径解析为 workspace 内绝对路径。绝对路径 / 路径穿越（..）都抛错。 */
export function resolveSafePath(root: string, relPath: unknown): string {
  const raw = String(relPath ?? "");
  if (raw.includes("\0")) {
    throw new WorkspaceError("absolute_path", "path contains NUL byte");
  }
  if (/^[\\/]/.test(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw)) {
    throw new WorkspaceError("absolute_path", `absolute path not allowed: ${raw}`);
  }
  const clean = normalizeRelPath(raw);
  if (!clean) throw new WorkspaceError("path_traversal", "empty path");
  const base = path.resolve(root);
  const abs = path.resolve(base, clean);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new WorkspaceError("path_traversal", `path escapes workspace: ${clean}`);
  }
  return abs;
}

/** 校验绝对路径位于 workspace 根内（不解析 symlink，仅字符串边界）。 */
export function assertInsideWorkspace(root: string, absPath: string): string {
  const base = path.resolve(root);
  const abs = path.resolve(absPath);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new WorkspaceError("not_inside_workspace", `path not inside workspace: ${absPath}`);
  }
  return abs;
}

/** 检查给定路径及其父链上的符号链接，任何逃逸到 workspace 外都抛 symlink_escape。 */
export function assertNoSymlinkEscape(root: string, absPath: string): void {
  const base = path.resolve(root);
  let current = path.resolve(absPath);
  const seen = new Set<string>();
  while (current !== base && current !== path.dirname(current)) {
    if (seen.has(current)) break;
    seen.add(current);
    let isLink = false;
    try {
      isLink = fs.lstatSync(current).isSymbolicLink();
    } catch {
      // 路径可能尚不存在（待写入），跳过
    }
    if (isLink) {
      const target = path.resolve(path.dirname(current), fs.readlinkSync(current));
      if (target !== base && !target.startsWith(base + path.sep)) {
        throw new WorkspaceError("symlink_escape", `symlink escapes workspace: ${current}`);
      }
    }
    current = path.dirname(current);
  }
}

/** 禁止写入 .env / .env.*（任何层级）。 */
export function assertAllowedFilename(relPath: unknown): void {
  const p = normalizeRelPath(relPath);
  const base = p.split("/").pop() ?? "";
  if (base.toLowerCase() === ".env" || /^\.env\.[a-z0-9_.-]+$/.test(base.toLowerCase())) {
    throw new WorkspaceError("env_reserved", `reserved filename not allowed: ${base}`);
  }
}

/** 校验相对路径深度不超过限制。 */
export function assertWithinDepth(relPath: unknown, maxDepth: number): void {
  const p = normalizeRelPath(relPath);
  const depth = p.split("/").filter(Boolean).length;
  if (depth > maxDepth) {
    throw new WorkspaceError("too_deep", `path too deep (${depth} > ${maxDepth}): ${p}`);
  }
}

/** 追加写入前的限额校验：增量大小与数量。 */
export function enforceAppendLimits(limits: WorkspaceLimits, addSize: number, currentFiles: number): void {
  if (addSize > limits.maxFileSize) {
    throw new WorkspaceError("file_too_large", `file exceeds maxFileSize (${addSize} > ${limits.maxFileSize})`);
  }
  if (currentFiles + 1 > limits.maxFiles) {
    throw new WorkspaceError("too_many_files", `file count exceeds maxFiles (${limits.maxFiles})`);
  }
}

/** 递归统计 workspace 内文件（相对路径 + 大小）。内部目录由 caller 决定是否排除。 */
export function walkWorkspace(root: string): { relPath: string; absPath: string; size: number; isLink: boolean }[] {
  const base = path.resolve(root);
  const out: { relPath: string; absPath: string; size: number; isLink: boolean }[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(base, abs).replace(/\\/g, "/");
      if (ent.isSymbolicLink()) {
        out.push({ relPath: rel, absPath: abs, size: 0, isLink: true });
        continue;
      }
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {}
      out.push({ relPath: rel, absPath: abs, size, isLink: false });
    }
  };
  walk(base);
  return out;
}

/** 全量扫描：任何 symlink 逃逸或文件大小/数量/总量超限都抛错。内部元数据（.go-ai/、workspace.json）不计入用户限额。 */
export function assertWorkspaceIntegrity(root: string, limits: WorkspaceLimits): void {
  const base = path.resolve(root);
  const files = walkWorkspace(base).filter((f) => !isInternalRelPath(f.relPath));
  let total = 0;
  for (const f of files) {
    if (f.isLink) {
      try {
        assertNoSymlinkEscape(base, f.absPath);
      } catch (e) {
        if (e instanceof WorkspaceError) throw e;
      }
      continue;
    }
    if (f.size > limits.maxFileSize) {
      throw new WorkspaceError("file_too_large", `file exceeds maxFileSize: ${f.relPath} (${f.size})`);
    }
    total += f.size;
    if (total > limits.maxTotalSize) {
      throw new WorkspaceError("total_too_large", `workspace exceeds maxTotalSize (${total})`);
    }
  }
  if (files.length > limits.maxFiles) {
    throw new WorkspaceError("too_many_files", `file count exceeds maxFiles (${files.length})`);
  }
}
