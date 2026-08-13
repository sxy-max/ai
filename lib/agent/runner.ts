/**
 * AgentRunner：把"调用 agent 执行"编排成一次有生命周期的 job。
 * 流程：建 job（queued）→ 写任务说明进 workspace → 经 SandboxRuntimeAdapter 执行（running）
 * → 拦截 artifacts 事件登记进 Artifact Service → done / failed（保留已登记的 partial 产物）。
 */

import fs from "node:fs";
import path from "node:path";
import type { ClientArtifact } from "../artifacts/types";
import type { SandboxRunEvent, SandboxRuntimeAdapter, SandboxRunRequest, SandboxRunResult } from "../sandbox/adapter";
import { WorkspaceManager } from "../workspace/service";
import { JobStore } from "./jobStore";

/** Runner 输出的收敛事件：job 生命周期 + adapter 归一化事件 + 已登记的 artifacts。 */
export type JobRunEvent =
  | { type: "job_status"; status: "queued" | "running" | "done" | "failed"; jobId: string; exitCode?: number; error?: string }
  | SandboxRunEvent
  | { type: "artifacts"; files: ClientArtifact[] };

export type RunAgentJobInput = {
  conversationId: string;
  jobId: string;
  prompt: string;
  maxTurns?: number;
  model?: string;
  memory?: string[];
  style?: string;
  skills?: string[];
  visionMd?: boolean;
  taskTitle?: string;
  visionContext?: string;
  timeoutMs?: number;
  workspace: WorkspaceManager;
  adapter: SandboxRuntimeAdapter;
  store: JobStore;
  /** 把 workspace 内文件登记进 Artifact Service；返回 null 表示跳过。 */
  registerArtifact: (name: string, content: Buffer) => Promise<ClientArtifact | null>;
};

export type JobRunOutcome = {
  status: "done" | "failed";
  result: SandboxRunResult;
  artifactCount: number;
};

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export async function runAgentJob(input: RunAgentJobInput, onEvent?: (event: JobRunEvent) => void): Promise<JobRunOutcome> {
  const { workspace, store, jobId, conversationId, adapter } = input;
  const emit = (event: JobRunEvent) => {
    try {
      onEvent?.(event);
    } catch {}
  };
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  store.create(jobId, conversationId);
  emit({ type: "job_status", status: "queued", jobId });

  try {
    workspace.writeTaskSpec({
      title: input.taskTitle || defaultTitle(input.prompt),
      prompt: input.prompt,
      model: input.model,
      memory: input.memory,
      style: input.style,
      visionContext: input.visionContext,
    });
  } catch {
    store.fail(jobId, "task_spec_write_failed");
    emit({ type: "job_status", status: "failed", jobId, error: "task_spec_write_failed" });
    return { status: "failed", result: { ok: false, error: "task_spec_write_failed" }, artifactCount: 0 };
  }

  store.start(jobId);
  emit({ type: "job_status", status: "running", jobId });

  let artifactCount = 0;
  const request: SandboxRunRequest = {
    job: { conversationId, jobId },
    prompt: input.prompt,
    maxTurns: input.maxTurns,
    model: input.model,
    memory: input.memory,
    style: input.style,
    skills: input.skills,
    visionMd: input.visionMd,
    timeoutMs,
  };

  let result: SandboxRunResult;
  try {
    result = await adapter.run(request, async (event) => {
      if (event.type !== "artifacts") {
        emit(event);
        return;
      }
      const files: ClientArtifact[] = [];
      for (const f of event.files) {
        const name = String(f.name || "download");
        const src = path.join(workspace.root, name);
        if (!src.startsWith(workspace.root + path.sep) || !fs.existsSync(src)) continue;
        try {
          const item = await input.registerArtifact(name, fs.readFileSync(src));
          if (item) {
            files.push(item);
            artifactCount++;
          }
        } catch {}
      }
      emit({ type: "artifacts", files });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { ok: false, error: message || "sandbox_run_failed", partial: false };
  }

  if (result.ok) {
    store.complete(jobId, { exitCode: result.exitCode, artifactCount });
    emit({ type: "job_status", status: "done", jobId, ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}) });
    return { status: "done", result, artifactCount };
  }

  store.fail(jobId, result.error, artifactCount);
  emit({ type: "job_status", status: "failed", jobId, error: result.error });
  return { status: "failed", result, artifactCount };
}

function defaultTitle(prompt: string): string {
  const first = prompt.split("\n").map((line) => line.trim()).find(Boolean) || "";
  return first.length > 60 ? first.slice(0, 60) + "…" : first || "文件任务";
}
