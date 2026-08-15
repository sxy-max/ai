/**
 * LocalSandboxProvider（V1.3 WP4）：宿主目录沙盒（development / fallback）。
 * 工具在 workspaceRoot 内执行（chdir + 限额包装）；无容器隔离——仅本地开发/回退。
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { SandboxExecResult, SandboxFileEntry, SandboxProvider, SandboxSpec } from "./manager";

export class LocalSandboxProvider implements SandboxProvider {
  readonly id = "local";

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "local sandbox always available" };
  }

  private rootOf(spec: SandboxSpec): string {
    return path.resolve(spec.workspaceRoot);
  }

  async allocate(spec: SandboxSpec): Promise<{ ok: boolean; error?: string }> {
    try {
      for (const dir of ["input", "working", "output"]) {
        fs.mkdirSync(path.join(this.rootOf(spec), dir), { recursive: true });
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "allocate failed" };
    }
  }

  async prepare(spec: SandboxSpec): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }

  exec(spec: SandboxSpec, command: string[], options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<SandboxExecResult> {
    const root = this.rootOf(spec);
    const cwd = options?.cwd ? path.join(root, options.cwd) : root;
    const timeoutMs = options?.timeoutMs || spec.limits.timeoutMs;
    const started = Date.now();
    return new Promise((resolve) => {
      const child = execFile(command[0], command.slice(1), {
        cwd,
        timeout: timeoutMs,
        maxBuffer: spec.limits.maxOutputBytes,
        env: { ...process.env, ...(options?.env || {}) },
        windowsHide: true,
      }, (error, stdout, stderr) => {
        const durationMs = Date.now() - started;
        const timedOut = Boolean(error && (error as { killed?: boolean; signal?: string }).killed && (error as { signal?: string }).signal === "SIGTERM");
        resolve({
          ok: !error || timedOut === false && (error as { code?: number }).code === 0,
          exitCode: error ? Number((error as { code?: number }).code ?? 1) : 0,
          stdout: String(stdout || "").slice(0, spec.limits.maxOutputBytes),
          stderr: String(stderr || "").slice(0, spec.limits.maxOutputBytes),
          durationMs,
          timedOut,
        });
      });
      // 超时强制 kill（execFile timeout 只发 SIGTERM）
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs + 1000);
      child.on("close", () => clearTimeout(timer));
    });
  }

  async readFile(spec: SandboxSpec, p: string): Promise<{ ok: boolean; content?: Buffer; error?: string }> {
    try {
      const abs = path.join(this.rootOf(spec), p);
      if (!abs.startsWith(this.rootOf(spec) + path.sep)) return { ok: false, error: "PATH_ESCAPE" };
      const stat = fs.statSync(abs);
      if (stat.size > spec.limits.maxFileBytes) return { ok: false, error: "file_too_large" };
      return { ok: true, content: fs.readFileSync(abs) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "read failed" };
    }
  }

  async writeFile(spec: SandboxSpec, p: string, content: Buffer): Promise<{ ok: boolean; error?: string }> {
    try {
      const abs = path.join(this.rootOf(spec), p);
      if (!abs.startsWith(this.rootOf(spec) + path.sep)) return { ok: false, error: "PATH_ESCAPE" };
      if (content.length > spec.limits.maxFileBytes) return { ok: false, error: "file_too_large" };
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "write failed" };
    }
  }

  async listFiles(spec: SandboxSpec, dir: string): Promise<{ ok: boolean; files?: SandboxFileEntry[]; error?: string }> {
    try {
      const abs = path.join(this.rootOf(spec), dir);
      if (!abs.startsWith(this.rootOf(spec) + path.sep) || !fs.existsSync(abs)) return { ok: false, error: "目录不存在" };
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const files = entries.slice(0, spec.limits.maxFiles).map((e) => ({
        path: path.join(dir, e.name).replace(/\\/g, "/"),
        size: e.isFile() ? fs.statSync(path.join(abs, e.name)).size : 0,
        isDir: e.isDirectory(),
      }));
      return { ok: true, files };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "list failed" };
    }
  }

  async snapshot(spec: SandboxSpec): Promise<{ ok: boolean; snapshotId?: string; error?: string }> {
    try {
      const root = this.rootOf(spec);
      const snapDir = path.join(root, ".snapshots");
      fs.mkdirSync(snapDir, { recursive: true });
      const snapshotId = `snap-${Date.now()}`;
      const target = path.join(snapDir, snapshotId);
      fs.mkdirSync(target, { recursive: true });
      // 复制 working/output（manifest 记录 hash）
      const manifest: Array<{ path: string; size: number; sha256: string }> = [];
      const crypto = await import("node:crypto");
      const walk = (dir: string, prefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
          else {
            const buf = fs.readFileSync(path.join(dir, entry.name));
            fs.copyFileSync(path.join(dir, entry.name), path.join(target, rel.replace(/\//g, "_")));
            manifest.push({ path: rel, size: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") });
          }
        }
      };
      for (const dir of ["working", "output"]) {
        if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir), dir);
      }
      fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2));
      return { ok: true, snapshotId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "snapshot failed" };
    }
  }

  async restore(spec: SandboxSpec, snapshotId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const root = this.rootOf(spec);
      const snapDir = path.join(root, ".snapshots", snapshotId);
      if (!fs.existsSync(snapDir)) return { ok: false, error: "snapshot not found" };
      const manifest = JSON.parse(fs.readFileSync(path.join(snapDir, "manifest.json"), "utf8")) as Array<{ path: string; size: number; sha256: string }>;
      for (const file of manifest) {
        // 还原到 working/output（按原相对路径）
        const parts = file.path.split("/");
        const area = parts[0]; // working | output
        const rel = parts.slice(1).join("/");
        const destDir = path.join(root, area);
        const dest = path.join(destDir, rel);
        if (!dest.startsWith(root + path.sep)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(snapDir, file.path.replace(/\//g, "_")), dest);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "restore failed" };
    }
  }

  async terminate(_spec: SandboxSpec): Promise<void> {}

  async cleanup(spec: SandboxSpec): Promise<void> {
    try {
      fs.rmSync(path.join(this.rootOf(spec), ".snapshots"), { recursive: true, force: true });
    } catch {}
  }
}
