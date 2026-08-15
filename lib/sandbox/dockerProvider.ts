/**
 * DockerSandboxProvider（V1.3 WP4-5，P0）：per-task 容器沙盒（production target）。
 *
 * 安全约束：
 *   - non-root（--user node / 指定 uid）
 *   - CPU/内存/pids 限制（--memory / --cpus / --pids-limit）
 *   - network restricted（--network none，或仅内部网络）
 *   - 只挂载 task workspace 数据卷（bind mount workspaceRoot）
 *   - 绝不挂载 docker.sock / 宿主敏感路径 / 其他 workspace
 *   - exec 超时 + 输出上限
 *
 * 依赖：docker CLI（编排者（worker）持 docker.sock；沙盒容器自身无任何宿主访问）。
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { SandboxExecResult, SandboxFileEntry, SandboxProvider, SandboxSpec } from "./manager";

const DEFAULT_IMAGE = process.env.SANDBOX_IMAGE || "go-ai-sandbox:v1";
const DOCKER_NETWORK = process.env.SANDBOX_NETWORK || "none";

export type DockerSandboxOptions = {
  dockerBin?: string;
  image?: string;
  /** 容器内工作目录（bind mount 目标）。 */
  containerWorkspace?: string;
};

function runDocker(bin: string, args: string[], timeoutMs: number, maxOutputBytes: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: maxOutputBytes, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        code: error ? Number((error as { code?: number }).code ?? 1) : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  });
}

/** 容器名（沙盒 id 派生）。 */
function containerName(sandboxId: string): string {
  return `goai-sbx-${String(sandboxId).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48)}`;
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly id = "docker";
  private readonly dockerBin: string;
  private readonly image: string;
  private readonly containerWorkspace: string;

  constructor(options: DockerSandboxOptions = {}) {
    this.dockerBin = options.dockerBin || process.env.DOCKER_BIN || "docker";
    this.image = options.image || process.env.SANDBOX_IMAGE || DEFAULT_IMAGE;
    this.containerWorkspace = options.containerWorkspace || process.env.SANDBOX_CONTAINER_WORKSPACE || "/workspace";
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const result = await runDocker(this.dockerBin, ["info", "--format", "{{.ServerVersion}}"], 10_000, 100_000);
      return result.code === 0 ? { ok: true, detail: `docker ${result.stdout.trim()}` } : { ok: false, detail: result.stderr.slice(0, 200) };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "docker unavailable" };
    }
  }

  async allocate(spec: SandboxSpec): Promise<{ ok: boolean; error?: string }> {
    const name = containerName(spec.sandboxId);
    const wsRoot = path.resolve(spec.workspaceRoot);
    if (!fs.existsSync(wsRoot)) return { ok: false, error: `workspace 不存在: ${wsRoot}` };
    const image = spec.image || this.image;
    const network = spec.network === "none" ? "none" : DOCKER_NETWORK;
    const args = [
      "run", "-d", "--name", name,
      "--user", "node",
      "--memory", `${spec.limits.memoryMb}m`,
      "--cpus", String(Math.max(spec.limits.cpuShares / 1024, 0.25)),
      "--pids-limit", String(spec.limits.pidsLimit),
      "--network", network,
      "--read-only",
      "--tmpfs", "/tmp:size=128m,mode=1777",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "-v", `${wsRoot}:${this.containerWorkspace}`,
      "--workdir", this.containerWorkspace,
      image,
      "sleep", "infinity",
    ];
    const result = await runDocker(this.dockerBin, args, 60_000, 100_000);
    if (result.code !== 0) {
      return { ok: false, error: result.stderr.slice(0, 500) || `docker run failed (${result.code})` };
    }
    return { ok: true };
  }

  async prepare(spec: SandboxSpec): Promise<{ ok: boolean; error?: string }> {
    // bind mount 已就绪；创建容器内 input/working/output
    const result = await this.exec(spec, ["sh", "-c", "mkdir -p input working output && chmod -R 777 input working output"]);
    return result.ok ? { ok: true } : { ok: false, error: result.stderr || "prepare failed" };
  }

  async exec(spec: SandboxSpec, command: string[], options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<SandboxExecResult> {
    const name = containerName(spec.sandboxId);
    const timeoutMs = options?.timeoutMs || spec.limits.timeoutMs;
    const started = Date.now();
    const args = ["exec"];
    if (options?.env) {
      for (const [k, v] of Object.entries(options.env)) args.push("-e", `${k}=${v}`);
    }
    if (options?.cwd) args.push("-w", path.posix.join(this.containerWorkspace, options.cwd));
    args.push(name, ...command);
    const result = await runDocker(this.dockerBin, args, timeoutMs + 2000, spec.limits.maxOutputBytes);
    const durationMs = Date.now() - started;
    return {
      ok: result.code === 0,
      exitCode: result.code,
      stdout: result.stdout.slice(0, spec.limits.maxOutputBytes),
      stderr: result.stderr.slice(0, spec.limits.maxOutputBytes),
      durationMs,
      timedOut: durationMs > timeoutMs,
    };
  }

  async readFile(spec: SandboxSpec, p: string): Promise<{ ok: boolean; content?: Buffer; error?: string }> {
    const result = await this.exec(spec, ["cat", path.posix.join(this.containerWorkspace, p)]);
    if (!result.ok) return { ok: false, error: result.stderr || "read failed" };
    return { ok: true, content: Buffer.from(result.stdout, "utf8") };
  }

  async writeFile(spec: SandboxSpec, p: string, content: Buffer): Promise<{ ok: boolean; error?: string }> {
    // base64 传输避免转义问题
    const b64 = content.toString("base64");
    const target = path.posix.join(this.containerWorkspace, p);
    const result = await this.exec(spec, ["sh", "-c", `mkdir -p $(dirname ${JSON.stringify(target)}) && echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(target)}`]);
    return result.ok ? { ok: true } : { ok: false, error: result.stderr || "write failed" };
  }

  async listFiles(spec: SandboxSpec, dir: string): Promise<{ ok: boolean; files?: SandboxFileEntry[]; error?: string }> {
    const target = path.posix.join(this.containerWorkspace, dir);
    const result = await this.exec(spec, ["sh", "-c", `ls -la ${JSON.stringify(target)} 2>/dev/null | tail -n +2`]);
    if (!result.ok) return { ok: false, error: result.stderr || "list failed" };
    const files: SandboxFileEntry[] = result.stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const parts = line.split(/\s+/);
        const isDir = parts[0]?.startsWith("d") || false;
        const name = parts.slice(8).join(" ");
        return { path: path.posix.join(dir, name), size: Number(parts[4] || 0), isDir };
      })
      .filter((f) => f.path && f.path !== `${dir}/.` && f.path !== `${dir}/..`);
    return { ok: true, files };
  }

  async snapshot(spec: SandboxSpec): Promise<{ ok: boolean; snapshotId?: string; error?: string }> {
    // 容器内 working/output → 数据卷内 .snapshots（bind mount 已覆盖）
    const name = containerName(spec.sandboxId);
    const snapshotId = `snap-${Date.now()}`;
    const result = await this.exec(spec, ["sh", "-c", `mkdir -p ${this.containerWorkspace}/.snapshots/${snapshotId} && cp -r ${this.containerWorkspace}/working ${this.containerWorkspace}/output ${this.containerWorkspace}/.snapshots/${snapshotId}/ 2>/dev/null; ls ${this.containerWorkspace}/.snapshots/${snapshotId}`]);
    if (!result.ok) return { ok: false, error: result.stderr || "snapshot failed" };
    void name;
    return { ok: true, snapshotId };
  }

  async restore(spec: SandboxSpec, snapshotId: string): Promise<{ ok: boolean; error?: string }> {
    const result = await this.exec(spec, ["sh", "-c", `rm -rf ${this.containerWorkspace}/working ${this.containerWorkspace}/output && cp -r ${this.containerWorkspace}/.snapshots/${snapshotId}/working ${this.containerWorkspace}/working && cp -r ${this.containerWorkspace}/.snapshots/${snapshotId}/output ${this.containerWorkspace}/output 2>/dev/null; echo done`]);
    return result.ok ? { ok: true } : { ok: false, error: result.stderr || "restore failed" };
  }

  async terminate(spec: SandboxSpec): Promise<void> {
    const name = containerName(spec.sandboxId);
    await runDocker(this.dockerBin, ["stop", "-t", "5", name], 30_000, 10_000).catch(() => {});
  }

  async cleanup(spec: SandboxSpec): Promise<void> {
    const name = containerName(spec.sandboxId);
    await runDocker(this.dockerBin, ["rm", "-f", name], 30_000, 10_000).catch(() => {});
    try {
      fs.rmSync(path.join(path.resolve(spec.workspaceRoot), ".snapshots"), { recursive: true, force: true });
    } catch {}
  }
}
