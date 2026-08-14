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
import { registerTaskArtifact, listTaskArtifacts } from "./artifacts";
import { emitTaskEvent } from "./repo";
import type { AgentRuntimeAdapter } from "../sandbox/adapter";
import type { ArtifactKind } from "../artifacts/types";
import type { TaskEventType } from "./types";
import type { JobEvent, JobStatus } from "../job/events";
import { validateTaskCompletion, type TaskCompletionContract } from "./completion";

/** workspace 状态摘要（修复指令用）：列出 output/working 文件与 input 文件。 */
async function summarizeWorkspace(ws: WorkspaceManager): Promise<string> {
  const fs = await import("node:fs");
  const lines: string[] = [];
  for (const dir of ["input", "working", "output"]) {
    const abs = path.join(ws.root, dir);
    if (!fs.existsSync(abs)) continue;
    const names = fs.readdirSync(abs).filter((n) => !n.startsWith("."));
    if (names.length) lines.push(`${dir}/: ${names.join(", ")}`);
  }
  return lines.join("；") || "（空）";
}

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

/** 任务级 Job 阶段 → task 事件（保持 UI 可见性）；同时落盘 events.ndjson 与日志（WP4）。 */
function emitJobEvent(emit: DevStepInput["emit"], event: JobEvent, recorder?: { ndjson: string; stdout: string; stderr: string }): void {
  void (async () => {
    if (recorder) {
      try {
        await (await import("node:fs")).promises.appendFile(recorder.ndjson, JSON.stringify({ ts: Date.now(), ...event }) + "\n");
        if (event.type === "text") {
          await (await import("node:fs")).promises.appendFile(recorder.stdout, String(event.text) + "\n");
        }
        if (event.type === "result") {
          await (await import("node:fs")).promises.appendFile(recorder.stdout, String(event.summary) + "\n");
        }
        if (event.type === "error") {
          await (await import("node:fs")).promises.appendFile(recorder.stderr, String(event.message) + "\n");
        }
      } catch {}
    }
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

  // 3. 用户文件 → input/（只读原始）+ working/（agent 可编辑副本）
  let staged = 0;
  for (const file of input.files) {
    const buf = artifactService.readContent(file.id);
    if (!buf) continue;
    try {
      ws.writeInputFile(file.filename, buf);
      const workingCopy = path.join(ws.dirs.working, file.filename);
      await (await import("node:fs")).promises.mkdir(path.dirname(workingCopy), { recursive: true });
      await (await import("node:fs")).promises.writeFile(workingCopy, buf);
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

  // 6. 执行（事件映射 task_events）；无产物时自动重试一次（强化交付指令）
  // 路径契约：file-agent 容器按 {conversationId}/{jobId} 定位 workspace
  // → conversationId="tasks"、jobId={taskId} 与 WORKSPACES_ROOT/tasks/{taskId} 对齐（agent 才能看到 input/）
  const jobId = input.taskId;
  const conversationId = "tasks";
  const store = new JobStore();
  await input.emit("agent.started", { worker: "dev", title: "Claude Code 沙盒执行中" });

  // WP4：执行记录（runtime.json / events.ndjson / logs）
  const agentDir = ws.dirs.agent;
  const logsDir = ws.dirs.logs;
  const eventsFile = path.join(agentDir, "events.ndjson");
  const stdoutFile = path.join(logsDir, "stdout.log");
  const stderrFile = path.join(logsDir, "stderr.log");
  const recorder = { ndjson: eventsFile, stdout: stdoutFile, stderr: stderrFile };
  await (await import("node:fs")).promises.writeFile(
    path.join(agentDir, "runtime.json"),
    JSON.stringify({ runtimeId: adapter.id, workspaceId: input.taskId, model: process.env.AGENT_MODEL || "deepseek-v4-flash", startedAt: Date.now() }, null, 2)
  );

  const runOnce = async (prompt: string, attempt: number): Promise<JobRunOutcome> => {
    ws.writeTaskSpec({ title: prompt.slice(0, 60), prompt, visionMd: vision.visionMd, fileManifest: true });
    const outcome = await runAgentJob(
      {
        conversationId,
        jobId,
        prompt,
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
      (event) => emitJobEvent(input.emit, event, recorder)
    );
    if (attempt === 0 && (outcome.status !== "done" || !outcome.result.ok)) {
      // 第一次执行失败 → 不自动重试（错误原因明确，留给用户重试）
      return outcome;
    }
    return outcome;
  };

  // 7. 兜底收集：agent 未上报但 output/ 已产出的文件（兼容根目录/working 落盘）
  const collectOutputs = async (): Promise<number> => {
    let collected = 0;
    const outputs = (await adapter.collectOutputs?.(ws.root)) || [];
    const knownDirs = new Set(["task", "input", "vision", "working", "output", "artifacts", "logs", ".go-ai"]);
    const candidates = [...outputs];
    // 根目录直接落盘的文件（agent 可能忽略 output/ 约定）
    try {
      const fs = await import("node:fs");
      for (const entry of fs.readdirSync(ws.root, { withFileTypes: true })) {
        if (entry.isFile() && !knownDirs.has(entry.name) && !entry.name.endsWith(".json")) {
          candidates.push({ relPath: entry.name, absPath: path.join(ws.root, entry.name), size: entry.isFile() ? fs.statSync(path.join(ws.root, entry.name)).size : 0, isDir: false });
        }
      }
    } catch {}
    const seen = new Set<string>();
    for (const output of candidates) {
      if (output.isDir) continue;
      const base = path.basename(output.relPath);
      const name = base.replace(/\.[^.]+$/, "");
      if (seen.has(name)) continue;
      seen.add(name);
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
    return collected;
  };

  // WP3：结构化纠错循环 Execute→Validate→Repair→Validate（有限次数）
  const maxAttempts = staged > 0 && input.goal.toLowerCase().includes("zip") ? 3 : 2;
  const attemptsDir = path.join(ws.dirs.agent, "attempts");
  await (await import("node:fs")).promises.mkdir(attemptsDir, { recursive: true });
  const simpleContract: TaskCompletionContract = {
    expectations: [{ kind: undefined, filenamePattern: "*", minCount: 1, validate: "format" }],
    minArtifacts: 1,
    validationPolicy: "strict"
  };

  let outcome = await runOnce(input.goal, 0);
  let collected = await collectOutputs();
  let verdict = await validateTaskCompletion(input.taskId, await listTaskArtifacts(input.taskId), simpleContract);

  for (let attempt = 1; attempt <= maxAttempts && verdict.status !== "completed"; attempt++) {
    // 记录 attempt（含失败原因与修复指令）
    const record = {
      attemptNumber: attempt,
      failureReason: verdict.reason,
      repairInstruction: `任务尚未完成。要求：${input.goal}
当前缺失：${verdict.missing.map((m) => m.filenamePattern || m.kind || "非空文件").join("、") || "非空交付文件"}
当前 Workspace 状态：${await summarizeWorkspace(ws)}
请实际修改/生成文件，并把最终文件写入 output/ 目录（或工作区根目录）。不要只描述，必须产出真实文件。`,
      maxAttempts,
      timestamp: Date.now()
    };
    await (await import("node:fs")).promises.writeFile(
      path.join(attemptsDir, `attempt-${attempt}.json`),
      JSON.stringify(record, null, 2)
    );
    await input.emit("progress", { detail: `第 ${attempt} 次执行未满足交付契约（${verdict.reason}），正在自动修复…` });

    outcome = await runOnce(record.repairInstruction, attempt);
    collected = await collectOutputs();
    verdict = await validateTaskCompletion(input.taskId, await listTaskArtifacts(input.taskId), simpleContract);
  }

  if (verdict.status !== "completed") {
    throw new Error(`TASK_CONTRACT_RETRYABLE：${verdict.reason}（已尝试 ${maxAttempts} 次）`);
  }

  if (outcome.status !== "done" || !outcome.result.ok) {
    const error = outcome.result.error || "DEV_RUN_FAILED";
    throw new Error(`DEV_RUN_${error}`);
  }
  const total = outcome.artifactCount + collected;
  // 中间 dev 步骤（检查/分析）可无产物；任务级产物校验由 worker 在完成阶段执行
  if (total === 0) {
    return { summary: "工作区步骤执行完成（本步骤无产物交付）" };
  }
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
