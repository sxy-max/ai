/**
 * SandboxManager（V1.3 WP4-5，P0）：任务级独立、安全、可管理的执行环境。
 *
 * 一个复杂任务 = 一个 sandbox。禁止所有 Agent 共用同一 writable workspace。
 * 提供两个 provider：
 *   - LocalSandboxProvider：宿主目录沙盒（development / fallback）
 *   - DockerSandboxProvider：per-task 容器（production target：
 *     non-root、CPU/内存/pids 限制、network restricted、仅挂载 task workspace 数据卷）
 *
 * 接口：allocate / prepare / exec / readFile / writeFile / listFiles /
 *       snapshot / restore / health / terminate / cleanup
 */

import type { SandboxRunEvent, SandboxRunRequest, SandboxRunResult } from "./adapter";

export type SandboxLimits = {
  memoryMb: number;
  cpuShares: number;
  pidsLimit: number;
  timeoutMs: number;
  maxOutputBytes: number;
  maxFileBytes: number;
  maxFiles: number;
};

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryMb: 512,
  cpuShares: 512,
  pidsLimit: 128,
  timeoutMs: 15 * 60 * 1000,
  maxOutputBytes: 1_000_000,
  maxFileBytes: 50 * 1024 * 1024,
  maxFiles: 10_000,
};

export type SandboxSpec = {
  sandboxId: string;
  /** 任务 workspace 数据（input/working/output 内容或路径）。 */
  workspaceRoot: string;
  limits: SandboxLimits;
  /** 镜像（Docker provider）。 */
  image?: string;
  /** 网络策略：restricted = 仅 DNS/内部（默认）；none = 无网络。 */
  network?: "restricted" | "none";
};

export type SandboxExecResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export type SandboxFileEntry = { path: string; size: number; isDir: boolean };

export interface SandboxProvider {
  readonly id: string;
  /** 就绪检查（provider 可用性）。 */
  health(): Promise<{ ok: boolean; detail?: string }>;
  /** 分配（创建容器/目录）。 */
  allocate(spec: SandboxSpec): Promise<{ ok: boolean; error?: string }>;
  /** 准备（注入 workspace 内容）。 */
  prepare(spec: SandboxSpec): Promise<{ ok: boolean; error?: string }>;
  /** 执行命令（受限环境内）。 */
  exec(spec: SandboxSpec, command: string[], options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<SandboxExecResult>;
  readFile(spec: SandboxSpec, path: string): Promise<{ ok: boolean; content?: Buffer; error?: string }>;
  writeFile(spec: SandboxSpec, path: string, content: Buffer): Promise<{ ok: boolean; error?: string }>;
  listFiles(spec: SandboxSpec, dir: string): Promise<{ ok: boolean; files?: SandboxFileEntry[]; error?: string }>;
  /** 快照（manifest + 内容清单）。 */
  snapshot(spec: SandboxSpec): Promise<{ ok: boolean; snapshotId?: string; error?: string }>;
  restore(spec: SandboxSpec, snapshotId: string): Promise<{ ok: boolean; error?: string }>;
  /** 终止（停止容器/释放）。 */
  terminate(spec: SandboxSpec): Promise<void>;
  /** 清理（删除容器/数据）。 */
  cleanup(spec: SandboxSpec): Promise<void>;
}

/** SandboxManager：provider 路由 + 生命周期编排。 */
export class SandboxManager {
  constructor(
    private readonly provider: SandboxProvider,
    private readonly limits: SandboxLimits = DEFAULT_SANDBOX_LIMITS
  ) {}

  get id(): string {
    return `sandbox-manager:${this.provider.id}`;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return this.provider.health();
  }

  async allocate(sandboxId: string, workspaceRoot: string, extra?: Partial<SandboxSpec>): Promise<{ ok: boolean; error?: string }> {
    return this.provider.allocate({
      sandboxId,
      workspaceRoot,
      limits: { ...this.limits, ...(extra?.limits || {}) },
      image: extra?.image,
      network: extra?.network || "restricted",
    });
  }

  async prepare(sandboxId: string, workspaceRoot: string): Promise<{ ok: boolean; error?: string }> {
    return this.provider.prepare({ sandboxId, workspaceRoot, limits: this.limits });
  }

  async exec(sandboxId: string, workspaceRoot: string, command: string[], options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<SandboxExecResult> {
    return this.provider.exec({ sandboxId, workspaceRoot, limits: this.limits }, command, options);
  }

  async readFile(sandboxId: string, workspaceRoot: string, path: string) {
    return this.provider.readFile({ sandboxId, workspaceRoot, limits: this.limits }, path);
  }

  async writeFile(sandboxId: string, workspaceRoot: string, path: string, content: Buffer) {
    return this.provider.writeFile({ sandboxId, workspaceRoot, limits: this.limits }, path, content);
  }

  async listFiles(sandboxId: string, workspaceRoot: string, dir: string) {
    return this.provider.listFiles({ sandboxId, workspaceRoot, limits: this.limits }, dir);
  }

  async snapshot(sandboxId: string, workspaceRoot: string) {
    return this.provider.snapshot({ sandboxId, workspaceRoot, limits: this.limits });
  }

  async restore(sandboxId: string, workspaceRoot: string, snapshotId: string) {
    return this.provider.restore({ sandboxId, workspaceRoot, limits: this.limits }, snapshotId);
  }

  async terminate(sandboxId: string, workspaceRoot: string): Promise<void> {
    await this.provider.terminate({ sandboxId, workspaceRoot, limits: this.limits });
  }

  async cleanup(sandboxId: string, workspaceRoot: string): Promise<void> {
    await this.provider.cleanup({ sandboxId, workspaceRoot, limits: this.limits });
  }
}

export type { SandboxRunEvent, SandboxRunRequest, SandboxRunResult };
