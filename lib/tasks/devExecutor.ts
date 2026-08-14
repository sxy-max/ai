/**
 * Dev Worker 执行器（WP3/WP4 接线）：任务系统 dev 步骤 → Claude Code Runtime。
 *
 * 链路（复用 v7 file-agent 基础设施，正式接入任务系统）：
 *   runtime 就绪检查（GoFileAgentAdapter.prepare）
 *   → 独立 workspace（WORKSPACES_ROOT/tasks/{taskId}：task/input/vision/working/output/artifacts/logs）
 *   → 用户文件进 input/
 *   → 图片 vision 预处理（MiniMax via OpenCode Go，vision/*.json + .md，双写 .go-ai 兼容旧容器）
 *   → task.json/task.md/context.json 落盘
 *   → runAgentJob（Claude Code + DeepSeek V4 Flash 容器）
 *   → 产物经 registerTaskArtifact 注册（PG 版本化 + 归属校验）
 *   → 事件映射 task_events（SSE/通知/UI 实时）
 *
 * 失败语义：runtime 不可用/产物为空 → 明确错误（DEV_RUNTIME_UNAVAILABLE / DEV_OUTPUT_EMPTY），
 * 不静默、不退回聊天。
 */

import path from "node:path";
import { artifactService } from "../artifacts/service";
import { GoFileAgentAdapter } from "../sandbox/dockerClaudeCode";
import { runAgentJob, JobRunOutcome } from "../agent/runner";
import { JobStore } from "../agent/jobStore";
import { WorkspaceManager } from "../workspace/service";
import { scanWorkspaceVision } from "../vision/workspaceScanner";
import { registerTaskArtifact } from "./artifacts";
import { emitTaskEvent } from "./repo";
import type { AgentRuntimeAdapter } from "../sandbox/adapter";
import type { ArtifactKind } from "../artifacts/types";
import type { TaskEventType } from "./types";
import type { JobEvent, JobStatus } from "../job/events";

export type DevStepInput = {
  taskId: string;
  stepId: string;
  userId: string;
  goal: string;
  projectId?: string | null;
  files: Array<{ id: string; filename: string }>;
  signal: AbortSignal;
  emit: (type: TaskEventType, payload?: Record<string, unknown>) => Promise<void>;
};

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || "/data/workspaces";

/** 任务级 Job 阶段 → task 事件（保持 UI 可见性）。 */
function emitJobEvent(emit: DevStepInput["emit"], event: JobEvent): void {
  void (async () => {
    try {
      switch (event.type) {
        case "status":
          await emit("progress", { stage: event.status, detail: event.message });
          break;
        case "tool":
          await emit("tool.started", { name: event.name, label: event.label || event.name });
          break;
        case "progress":
          await emit("progress", { detail: event.detail });
          break;
        case "result":
          await emit("progress", { detail: event.summary });
          break;
        case "artifact":
          await emit("artifact.created", { name: event.artifact.name, downloadUrl: event.artifact.downloadUrl });
          break;
        case "error":
          await emit("tool.completed", { name: "sandbox", ok: false, output: event.message });
          break;
        case "done":
          await emit("tool.completed", { name: "sandbox", ok: event.exitCode === 0, output: `退出码 ${event.exitCode}` });
          break;
      }
    } catch {}
  })();
}

export async function runDevStep(input: DevStepInput, deps?: { adapter?: AgentRuntimeAdapter; workspacesRoot?: string }): Promise<{ summary: string }> {
  // 1. runtime 就绪（Claude Code + DeepSeek V4 Flash 容器；测试可注入 fake）
  const adapter = deps?.adapter || new GoFileAgentAdapter();
  const prepared = await adapter.prepare();
  if (!prepared.ok) throw new Error(`DEV_RUNTIME_UNAVAILABLE：${prepared.error}`);

  // 2. 独立 workspace（task 隔离；与 file-agent 容器共享挂载卷）
  const root = path.join(deps?.workspacesRoot || WORKSPACES_ROOT, "tasks", input.taskId);
  const ws = new WorkspaceManager(root);
  ws.createWorkspace();

  // 3. 用户文件 → input/
  let staged = 0;
  for (const file of input.files) {
    const buf = artifactService.readContent(file.id);
    if (!buf) continue;
    try {
      ws.writeInputFile(file.filename, buf);
      staged++;
    } catch {
      // 非法文件名/超限文件跳过，不阻塞
    }
  }
  await input.emit("tool.started", { name: "workspace", label: `工作区就绪（${staged}/${input.files.length} 文件入 input/）` });

  // 4. vision 预处理（input 有图片时；key 复用 OpenCode Go 通道）
  const vision = await scanWorkspaceVision(ws, process.env.OPENCODE_GO_API_KEY || "");
  if (vision.scanned > 0) {
    await input.emit("progress", { detail: `视觉分析 ${vision.scanned} 张图片${vision.failures ? `（${vision.failures} 张失败）` : ""}` });
  }

  // 5. 任务说明 + 上下文落盘
  ws.writeTaskSpec({
    title: input.goal.slice(0, 60),
    prompt: input.goal,
    visionMd: vision.visionMd,
    fileManifest: true,
  });

  // 6. 执行（事件映射 task_events）
  const jobId = `task-${input.taskId}`;
  const store = new JobStore();
  await input.emit("agent.started", { worker: "dev", title: "Claude Code 沙盒执行中" });

  const outcome: JobRunOutcome = await runAgentJob(
    {
      conversationId: jobId,
      jobId,
      prompt: input.goal,
      maxTurns: 15,
      visionMd: vision.visionMd,
      fileManifest: true,
      workspace: ws,
      adapter,
      store,
      registerArtifact: async (name: string, content: Buffer) => {
        const kind = kindFromFilename(name);
        const artifact = await registerTaskArtifact({
          taskId: input.taskId,
          userId: input.userId,
          projectId: input.projectId ?? null,
          filename: path.basename(name),
          name: path.basename(name).replace(/\.[^.]+$/, ""),
          kind,
          mime: mimeFromKind(kind),
          content
        });
        return { id: artifact.id, kind: artifact.type as ArtifactKind, name: artifact.name, mime: artifact.mime, size: artifact.size, status: artifact.status as "ready", downloadUrl: `/api/artifacts/${artifact.id}` };
      }
    },
    (event) => emitJobEvent(input.emit, event)
  );

  // 7. 兜底收集：agent 未上报但 output/ 已产出的文件
  let collected = 0;
  const outputs = (await adapter.collectOutputs?.(ws.root)) || [];
  for (const output of outputs) {
    if (output.isDir) continue;
    const base = path.basename(output.relPath);
    const name = base.replace(/\.[^.]+$/, "");
    const already = await listRegisteredNames(input.taskId);
    if (already.has(name)) continue;
    try {
      const buf = artifactService.readContent(output.absPath) ?? (await import("node:fs")).readFileSync(output.absPath);
      const kind = kindFromFilename(output.relPath);
      await registerTaskArtifact({
        taskId: input.taskId,
        userId: input.userId,
        projectId: input.projectId ?? null,
        filename: base,
        name,
        kind,
        mime: mimeFromKind(kind),
        content: buf
      });
      collected++;
      await input.emit("artifact.created", { name: base, downloadUrl: `/api/artifacts/${await latestArtifactId(input.taskId, name)}` });
    } catch {}
  }

  if (outcome.status !== "done" || !outcome.result.ok) {
    const error = outcome.result.error || "DEV_RUN_FAILED";
    throw new Error(`DEV_RUN_${error}`);
  }
  const total = outcome.artifactCount + collected;
  if (total === 0) throw new Error("DEV_OUTPUT_EMPTY：Agent 未产出可下载文件");

  return { summary: `工作区执行完成，交付 ${total} 个文件（产物已注册并可下载）` };
}

async function listRegisteredNames(taskId: string): Promise<Set<string>> {
  const { listTaskArtifacts } = await import("./artifacts");
  const artifacts = await listTaskArtifacts(taskId);
  return new Set(artifacts.map((a) => a.name));
}

async function latestArtifactId(taskId: string, name: string): Promise<string> {
  const { listTaskArtifacts } = await import("./artifacts");
  const artifacts = await listTaskArtifacts(taskId);
  const found = artifacts.find((a) => a.name === name);
  return found?.id || "";
}

function kindFromFilename(filename: string): ArtifactKind {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".html": return "html";
    case ".md": return "markdown";
    case ".pdf": return "pdf";
    case ".csv": return "csv";
    case ".xlsx": return "xlsx";
    case ".pptx": return "pptx";
    case ".docx": return "docx";
    case ".png": case ".jpg": case ".jpeg": case ".gif": case ".webp": case ".svg": return "image";
    case ".zip": return "zip";
    case ".json": return "json";
    case ".txt": return "txt";
    default: return "code";
  }
}

function mimeFromKind(kind: string): string {
  switch (kind) {
    case "html": return "text/html";
    case "markdown": return "text/markdown";
    case "pdf": return "application/pdf";
    case "csv": return "text/csv";
    case "json": return "application/json";
    case "txt": return "text/plain";
    case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "image": return "image/png";
    case "zip": return "application/zip";
    default: return "text/plain";
  }
}
