/**
 * Sandbox Runtime（V1.1 WP5）：执行环境抽象。
 * 业务（Task/Agent）只认识 runtimeId / workspaceId，不接触：
 *   Docker container name、host path、v7 file-agent 特殊路径。
 *
 * 第一实现：DockerSandboxRuntime —— 组合 WorkspaceManager（共享卷文件访问）
 * 与 AgentRuntimeAdapter（容器 exec 流式），契约与现有 file-agent 容器对齐。
 * 未来可替换：AgentScope Runtime / E2B / Modal / microVM，不重写任务系统。
 */

import fs from "node:fs";
import path from "node:path";
import { WorkspaceManager } from "../workspace/service";
import type { AgentRuntimeAdapter, CollectedOutput, SandboxRunRequest, SandboxRunEvent, SandboxRunResult } from "./adapter";

export type RuntimeSession = {
  runtimeId: string;
  workspaceId: string;
  workspaceRoot: string;
  createdAt: number;
};

export type StagedFile = { relPath: string; content: Buffer };

export type ExecOptions = {
  prompt: string;
  maxTurns?: number;
  model?: string;
  visionMd?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type FileEntry = { relPath: string; size: number; isDir: boolean };

export interface SandboxRuntime {
  /** 创建会话（runtimeId + workspace 绑定）。 */
  create(workspaceId: string, workspaceRoot: string): Promise<RuntimeSession>;
  /** 把文件放入 workspace input/（只读原始）。 */
  stageInput(session: RuntimeSession, files: StagedFile[]): Promise<number>;
  /** 执行 agent run；事件按序回调。 */
  exec(session: RuntimeSession, options: ExecOptions, onEvent: (event: SandboxRunEvent) => void | Promise<void>): Promise<SandboxRunResult>;
  /** 读取 workspace 文件（相对路径）。 */
  readFile(session: RuntimeSession, relPath: string): Promise<Buffer | null>;
  /** 写入 workspace 文件（相对路径，防穿越）。 */
  writeFile(session: RuntimeSession, relPath: string, content: Buffer): Promise<void>;
  /** 列出 workspace 文件。 */
  listFiles(session: RuntimeSession): Promise<FileEntry[]>;
  /** 收集产物（output/ + artifacts/ + 根目录文件）。 */
  collectFiles(session: RuntimeSession): Promise<CollectedOutput[]>;
  /** 终止执行中的 run。 */
  kill(session: RuntimeSession): Promise<void>;
  /** 销毁会话（清理会话态；workspace 目录由 scheduler 统一管理）。 */
  destroy(session: RuntimeSession): Promise<void>;
}

/** 第一实现：Docker 共享卷 + file-agent 容器 exec。 */
export class DockerSandboxRuntime implements SandboxRuntime {
  constructor(private readonly adapter: AgentRuntimeAdapter, private readonly workspacesRoot: string) {}

  async create(workspaceId: string, workspaceRoot: string): Promise<RuntimeSession> {
    return {
      runtimeId: `docker-${workspaceId}`,
      workspaceId,
      workspaceRoot: path.resolve(workspaceRoot),
      createdAt: Date.now()
    };
  }

  async stageInput(session: RuntimeSession, files: StagedFile[]): Promise<number> {
    const ws = new WorkspaceManager(session.workspaceRoot);
    ws.createWorkspace();
    let staged = 0;
    for (const file of files) {
      try {
        ws.writeInputFile(file.relPath, file.content);
        staged++;
      } catch {}
    }
    return staged;
  }

  async exec(
    session: RuntimeSession,
    options: ExecOptions,
    onEvent: (event: SandboxRunEvent) => void | Promise<void>
  ): Promise<SandboxRunResult> {
    const request: SandboxRunRequest = {
      job: { conversationId: "tasks", jobId: session.workspaceId },
      prompt: options.prompt,
      maxTurns: options.maxTurns ?? 15,
      model: options.model,
      visionMd: options.visionMd,
      timeoutMs: options.timeoutMs,
      signal: options.signal
    };
    return this.adapter.execute(request, onEvent);
  }

  async readFile(session: RuntimeSession, relPath: string): Promise<Buffer | null> {
    const ws = new WorkspaceManager(session.workspaceRoot);
    try {
      return ws.readWorkspaceFile(relPath);
    } catch {
      return null;
    }
  }

  async writeFile(session: RuntimeSession, relPath: string, content: Buffer): Promise<void> {
    const target = path.join(session.workspaceRoot, relPath);
    if (!target.startsWith(session.workspaceRoot + path.sep)) throw new Error("PATH_ESCAPE");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  async listFiles(session: RuntimeSession): Promise<FileEntry[]> {
    const ws = new WorkspaceManager(session.workspaceRoot);
    return ws.listWorkspaceFiles().map((f) => ({ relPath: f.relPath, size: f.size, isDir: false }));
  }

  async collectFiles(session: RuntimeSession): Promise<CollectedOutput[]> {
    const ws = new WorkspaceManager(session.workspaceRoot);
    const collected = ws.collectOutputs();
    // collectOutputs 的 relPath 相对产出目录（output/ 或 artifacts/）——规范化为相对 workspace 根
    return collected.map((c) => {
      const rel = c.relPath.startsWith("output/") || c.relPath.startsWith("artifacts/")
        ? c.relPath
        : c.absPath.includes(path.join(session.workspaceRoot, "output"))
          ? `output/${c.relPath}`
          : `artifacts/${c.relPath}`;
      return { relPath: rel, absPath: c.absPath, size: c.size, isDir: false };
    });
  }

  async kill(session: RuntimeSession): Promise<void> {
    await this.adapter.cancel?.(session.workspaceId);
  }

  async destroy(session: RuntimeSession): Promise<void> {
    await this.adapter.cleanup?.(session.workspaceId);
  }
}

/** 运行时工厂：当前使用 Docker 共享卷实现。 */
export function createSandboxRuntime(adapter: AgentRuntimeAdapter, workspacesRoot: string): SandboxRuntime {
  return new DockerSandboxRuntime(adapter, workspacesRoot);
}
