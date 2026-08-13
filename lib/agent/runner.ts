/**
 * Agent Runner：把"调用 agent 执行"编排成一次有生命周期的 job，并输出 Job Event Stream。
 * 流程：queued → creating_workspace（写任务说明）→ 执行（工具名驱动 reading_files/editing/
 * running_check/generating_artifact 等阶段）→ 拦截 artifacts 登记进 Artifact Service
 * → 终态 done / failed（保留已登记的 partial 产物）。
 */

import fs from "node:fs";
import path from "node:path";
import type { ClientArtifact } from "../artifacts/types";
import type { SandboxRuntimeAdapter } from "../sandbox/adapter";
import { statusForTool, statusLabel, toolLabel } from "../job/events";
import type { JobEvent, JobStatus } from "../job/events";
import type { WorkspaceManager } from "../workspace/service";
import type { JobStore } from "./jobStore";

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
  registerArtifact: (name: string, content: Buffer) => Promise<ClientArtifact | null | undefined>;
};

export type JobRunOutcome = {
  status: "done" | "failed";
  result: { ok: boolean; exitCode?: number; error?: string; partial?: boolean };
  artifactCount: number;
};

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export async function runAgentJob(input: RunAgentJobInput, onEvent?: (event: JobEvent) => void): Promise<JobRunOutcome> {
  const { workspace, store, jobId, conversationId, adapter } = input;
  const emit = (event: JobEvent) => {
    try {
      onEvent?.(event);
    } catch {}
  };
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  store.create(jobId, conversationId);
  emit({ type: "status", status: "queued", message: statusLabel("queued") });

  store.updateStatus(jobId, "creating_workspace");
  emit({ type: "status", status: "creating_workspace", message: statusLabel("creating_workspace") });
  try {
    workspace.writeTaskSpec({
      title: input.taskTitle || defaultTitle(input.prompt),
      prompt: input.prompt,
      model: input.model,
      memory: input.memory,
      style: input.style,
      visionContext: input.visionContext,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.updateStatus(jobId, "failed", { error: message });
    emit({ type: "error", code: "task_spec_write_failed", message: `任务说明写入失败：${message}` });
    emit({ type: "status", status: "failed", message: statusLabel("failed") });
    return { status: "failed", result: { ok: false, error: message }, artifactCount: 0 };
  }

  store.updateStatus(jobId, "reading_files");
  emit({ type: "status", status: "reading_files", message: statusLabel("reading_files") });

  let artifactCount = 0;
  let phase: JobStatus = "reading_files";

  const request = {
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

  let result: { ok: boolean; exitCode?: number; error?: string; partial?: boolean };
  try {
    const ran = await adapter.run(request, async (event) => {
      switch (event.type) {
        case "tool": {
          emit({ type: "tool", name: event.name, label: toolLabel(event.name) });
          const next = statusForTool(event.name);
          if (next !== phase) {
            phase = next;
            store.updateStatus(jobId, next);
            emit({ type: "status", status: next, message: statusLabel(next) });
          }
          break;
        }
        case "text":
          emit({ type: "progress", detail: event.text });
          break;
        case "result":
          emit({ type: "result", summary: event.result });
          break;
        case "artifacts": {
          for (const f of event.files) {
            const name = String(f.name || "download");
            const src = path.join(workspace.root, name);
            if (!src.startsWith(workspace.root + path.sep) || !fs.existsSync(src)) continue;
            try {
              const item = await input.registerArtifact(name, fs.readFileSync(src));
              if (item) {
                artifactCount++;
                emit({ type: "artifact", artifact: item });
              }
            } catch {}
          }
          break;
        }
        case "done":
          emit({ type: "done", exitCode: event.exitCode ?? 0 });
          break;
        case "error":
          emit({ type: "error", code: "sandbox_error", message: event.message });
          break;
      }
    });
    result = ran;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { ok: false, error: message || "sandbox_run_failed", partial: false };
  }

  if (result.ok) {
    store.updateStatus(jobId, "done", { exitCode: result.exitCode, artifactCount });
    emit({ type: "status", status: "done", message: result.exitCode === 0 ? "已完成" : "未完全完成，已保留结果" });
    return { status: "done", result, artifactCount };
  }

  store.updateStatus(jobId, "failed", { error: result.error, artifactCount });
  emit({ type: "status", status: "failed", message: statusLabel("failed") });
  return { status: "failed", result, artifactCount };
}

function defaultTitle(prompt: string): string {
  const first = prompt.split("\n").map((line) => line.trim()).find(Boolean) || "";
  return first.length > 60 ? first.slice(0, 60) + "…" : first || "文件任务";
}
