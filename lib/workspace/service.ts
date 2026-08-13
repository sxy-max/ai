/** Workspace Manager —— agent_workspace 任务的安全工作目录系统。
 *  创建 / 写入 / 读取 / 收集 / 清理，全部经过路径与限额安全校验。 */

import fs from "node:fs";
import path from "node:path";
import { buildDirs, isInternalRelPath, mergeLimits, readMeta, writeMeta } from "./metadata";
import {
  assertAllowedFilename,
  assertInsideWorkspace,
  assertNoSymlinkEscape,
  assertWorkspaceIntegrity,
  normalizeRelPath,
  resolveSafePath,
  walkWorkspace,
} from "./safety";
import type { CollectedFile, TaskSpec, WorkspaceFileInfo, WorkspaceLimits, WorkspaceMeta } from "./types";
import { WorkspaceError } from "./types";

export class WorkspaceManager {
  readonly root: string;
  readonly dirs: ReturnType<typeof buildDirs>;
  readonly limits: WorkspaceLimits;

  constructor(root: string, limits?: Partial<WorkspaceLimits>) {
    this.root = path.resolve(root);
    this.dirs = buildDirs(this.root);
    this.limits = mergeLimits(limits);
  }

  get id(): string {
    return path.basename(this.root);
  }

  getMeta(): WorkspaceMeta {
    const existing = readMeta(this.root);
    if (existing) return existing;
    const meta: WorkspaceMeta = {
      id: this.id,
      root: this.root,
      createdAt: Date.now(),
      limits: this.limits,
      dirs: this.dirs,
      status: "ready",
    };
    writeMeta(meta);
    return meta;
  }

  /** 创建 workspace 目录结构并写入元数据。 */
  createWorkspace(): this {
    for (const dir of [this.dirs.input, this.dirs.output, this.dirs.artifacts, this.dirs.task, this.dirs.internal]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const meta: WorkspaceMeta = {
      id: this.id,
      root: this.root,
      createdAt: Date.now(),
      limits: this.limits,
      dirs: this.dirs,
      status: "ready",
    };
    writeMeta(meta);
    return this;
  }

  /** 写入前统一校验：路径安全 + symlink 逃逸 + 限额。返回安全的目标绝对路径。 */
  private precheckWrite(relPath: unknown, size: number, baseDir: string): string {
    const raw = String(relPath ?? "");
    const clean = normalizeRelPath(raw);
    if (!clean) throw new WorkspaceError("path_traversal", "empty path");
    assertAllowedFilename(clean);
    assertWithinDepthByPath(clean, this.limits.maxDepth);
    const target = resolveSafePath(baseDir, raw);
    assertNoSymlinkEscape(this.root, target);

    const files = walkWorkspace(this.root).filter((f) => !isInternalRelPath(f.relPath));
    const total = files.reduce((s, f) => s + f.size, 0);
    const count = files.length;
    if (size > this.limits.maxFileSize) {
      throw new WorkspaceError("file_too_large", `file exceeds maxFileSize (${size} > ${this.limits.maxFileSize})`);
    }
    if (total + size > this.limits.maxTotalSize) {
      throw new WorkspaceError("total_too_large", `workspace exceeds maxTotalSize (${total + size} > ${this.limits.maxTotalSize})`);
    }
    if (count + 1 > this.limits.maxFiles) {
      throw new WorkspaceError("too_many_files", `file count exceeds maxFiles (${this.limits.maxFiles})`);
    }
    return target;
  }

  /** 写入用户上传文件到 input/。 */
  writeInputFile(relPath: string, content: string | Buffer): string {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
    const target = this.precheckWrite(relPath, buf.length, this.dirs.input);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
    return path.relative(this.root, target).replace(/\\/g, "/");
  }

  /** 写入任务说明（结构化 json + 可读 markdown）。 */
  writeTaskSpec(spec: TaskSpec): void {
    if (!spec || typeof spec.prompt !== "string" || !spec.prompt.trim()) {
      throw new WorkspaceError("path_traversal", "task spec prompt required");
    }
    const json = JSON.stringify({ ...spec, writtenAt: Date.now() }, null, 2);
    this.precheckWrite("task.json", Buffer.byteLength(json), this.dirs.task);
    fs.writeFileSync(path.join(this.dirs.task, "task.json"), json);

    const lines = [
      spec.title ? `# ${spec.title}` : "# Task",
      "",
      "## 任务说明",
      spec.prompt,
      "",
      spec.visionContext ? "## 视觉上下文（不可信来源）\n\n" + spec.visionContext : "",
      spec.style ? "## 风格\n\n" + spec.style : "",
      "",
      "请把修改/生成的结果写到 output/ 目录。",
    ].filter((l) => l !== null);
    fs.writeFileSync(path.join(this.dirs.task, "task.md"), lines.join("\n"));

    const meta = this.getMeta();
    meta.taskSpec = spec.prompt;
    writeMeta(meta);
  }

  /** 列出 workspace 内全部文件（含区域标记）。 */
  listWorkspaceFiles(): WorkspaceFileInfo[] {
    const files = walkWorkspace(this.root);
    return files.map((f) => ({
      relPath: f.relPath,
      absPath: f.absPath,
      size: f.size,
      area: areaOf(f.relPath),
    }));
  }

  /** 读取 workspace 内任意文件（相对路径）。不存在返回 null。 */
  readWorkspaceFile(relPath: string): Buffer | null {
    const target = resolveSafePath(this.root, relPath);
    assertNoSymlinkEscape(this.root, target);
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return null;
    return fs.readFileSync(target);
  }

  /** 校验当前 workspace 完整性（symlink/大小/数量）。 */
  assertWorkspaceIntegrity(): void {
    assertWorkspaceIntegrity(this.root, this.limits);
  }

  /** 校验绝对路径位于 workspace 内。 */
  assertInsideWorkspace(absPath: string): string {
    return assertInsideWorkspace(this.root, absPath);
  }

  /** 收集 output/ 与 artifacts/ 下的产物，供后续 Artifact Service 使用。 */
  collectOutputs(): CollectedFile[] {
    this.assertWorkspaceIntegrity();
    const out: CollectedFile[] = [];
    const push = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const f of walkWorkspace(dir)) {
        if (f.isLink) continue;
        let buf: Buffer;
        try {
          buf = fs.readFileSync(f.absPath);
        } catch {
          continue;
        }
        out.push({ relPath: f.relPath, absPath: f.absPath, name: path.basename(f.absPath), size: buf.length, buffer: buf });
      }
    };
    push(this.dirs.output);
    push(this.dirs.artifacts);
    return out;
  }

  /** 清理 workspace：只删除当前 root，绝不触碰 root 之外。 */
  cleanupWorkspace(): void {
    const parsed = path.parse(this.root);
    if (this.root === parsed.root || this.root === path.sep) {
      throw new WorkspaceError("path_traversal", "refusing to remove filesystem root");
    }
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  /** 默认实例：生产根目录可用 WORKSPACES_ROOT 覆盖。 */
  static defaultRoot(): string {
    return process.env.WORKSPACES_ROOT || "/data/workspaces";
  }

  /** 清理 WORKSPACES_ROOT 下超过 ttlMs 未活动的 workspace。只删除带合法 workspace.json 的目录，返回清理数量。 */
  static cleanupExpired(root: string, ttlMs: number, now = Date.now()): number {
    const base = path.resolve(root);
    if (!fs.existsSync(base)) return 0;
    let removed = 0;
    for (const conv of fs.readdirSync(base, { withFileTypes: true })) {
      if (!conv.isDirectory()) continue;
      const convPath = path.join(base, conv.name);
      for (const job of fs.readdirSync(convPath, { withFileTypes: true })) {
        if (!job.isDirectory()) continue;
        const wsPath = path.join(convPath, job.name);
        const meta = readMeta(wsPath);
        if (!meta || typeof meta.createdAt !== "number") continue;
        if (now - meta.createdAt > ttlMs) {
          try {
            fs.rmSync(wsPath, { recursive: true, force: true });
            removed++;
          } catch {}
        }
      }
    }
    return removed;
  }
}

function assertWithinDepthByPath(relPath: string, maxDepth: number): void {
  const depth = relPath.split("/").filter(Boolean).length;
  if (depth > maxDepth) {
    throw new WorkspaceError("too_deep", `path too deep (${depth} > ${maxDepth}): ${relPath}`);
  }
}

function areaOf(relPath: string): WorkspaceFileInfo["area"] {
  const p = relPath.replace(/\\/g, "/");
  if (p === ".go-ai" || p.startsWith(".go-ai/") || p === "workspace.json") return "internal";
  if (p === "input" || p.startsWith("input/")) return "input";
  if (p === "output" || p.startsWith("output/")) return "output";
  if (p === "artifacts" || p.startsWith("artifacts/")) return "artifacts";
  return "internal";
}
