import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
import { latestJobForTask } from "../../../../lib/tasks/job";
import { taskFiles } from "../../../../lib/tasks/repo";
import {
  cancelTask,
  continueTask,
  getSteps,
  getTask,
  pauseTask,
  resumeTask,
  retryTask
} from "../../../../lib/tasks/repo";
import { listTaskArtifacts } from "../../../../lib/tasks/artifacts";
import { isRecord, readJsonBody } from "../../../../lib/http";
import { serializeTask } from "../route";
import type { TaskRow } from "../../../../lib/tasks/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Task 详情与操作：
 * GET   /api/tasks/:id           详情（task + steps + artifacts + events 尾部）
 * PATCH /api/tasks/:id           { action: pause|resume|cancel|retry }
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  const task = await getTask((await params).id);
  if (!task || task.user_id !== user.id) return NextResponse.json({ ok: false, error: "任务不存在" }, { status: 404 });

  const [steps, artifacts, events, job, files] = await Promise.all([
    getSteps(task.id),
    listTaskArtifacts(task.id),
    listRecentEvents(task.id),
    latestJobForTask(task.id).catch(() => null),
    taskFiles(task.id).catch(() => []),
  ]);

  // V1.3 WP33：失败语义化（用户看到原因，不暴露内部堆栈）
  let failureLabel: string | null = null;
  if (job?.failure_code) {
    const labels: Record<string, string> = {
      MODEL_UNAVAILABLE: "模型暂时不可用", MODEL_REGION_UNAVAILABLE: "模型在当前区域不可用",
      MODEL_REASONING_TRUNCATED: "模型推理被截断", MODEL_NO_FINAL: "模型未返回最终结果",
      RUNTIME_START_FAILED: "执行环境启动失败", RUNTIME_TIMEOUT: "执行环境超时",
      TOOL_FAILED: "工具执行失败", WORKSPACE_FAILED: "工作区异常",
      ARTIFACT_MISSING: "未生成要求的输出文件", ARTIFACT_INVALID: "输出文件格式验证失败",
      VISION_FAILED: "图片分析失败", VALIDATION_FAILED: "输出验证失败",
      TASK_CANCELLED: "任务已取消",
    };
    failureLabel = labels[job.failure_code] || job.failure_code;
  }

  return NextResponse.json({
    ok: true,
    task: serializeTask(task),
    // V1.3 WP31：Job 执行信息（attempt/runtime/模型/失败语义）
    job: job ? {
      id: job.id,
      attempt: job.attempt,
      status: job.status,
      runtime: job.runtime,
      model: job.model,
      current_step: job.current_step,
      failure_code: job.failure_code,
      failureLabel,
      created_at: job.created_at,
    } : null,
    steps: steps.map((step) => ({
      id: step.id, seq: step.seq, worker_type: step.worker_type, title: step.title,
      goal: step.goal, status: step.status, detail: step.detail, error: step.error,
      started_at: step.started_at, completed_at: step.completed_at
    })),
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id, name: artifact.name, type: artifact.type, version: artifact.version,
      size: artifact.size, mime: artifact.mime, status: artifact.status,
      downloadUrl: `/api/artifacts/${artifact.id}`, created_at: artifact.created_at
    })),
    // V1.3 WP32：任务文件区（上传文件列表）
    files: files.map((file) => ({
      id: String(file.id),
      filename: String(file.filename),
      mime: String(file.mime || ""),
      size: Number(file.size || 0),
    })),
    events
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  const id = (await params).id;
  const task = await getTask(id);
  if (!task || task.user_id !== user.id) return NextResponse.json({ ok: false, error: "任务不存在" }, { status: 404 });

  const raw = await readJsonBody(request, 4_096).catch(() => ({}));
  const action = isRecord(raw) && typeof raw.action === "string" ? raw.action : "";
  try {
    switch (action) {
      case "pause": await pauseTask(id); break;
      case "resume": await resumeTask(id); break;
      case "cancel": await cancelTask(id); break;
      case "retry": await retryTask(id); break;
      case "continue": {
        const goal = isRecord(raw) && typeof raw.goal === "string" ? raw.goal : "";
        await continueTask(id, goal);
        break;
      }
      default: return NextResponse.json({ ok: false, error: "action 必须为 pause/resume/cancel/retry/continue" }, { status: 400 });
    }
    const updated = await getTask(id);
    return NextResponse.json({ ok: true, task: serializeTask(updated as TaskRow) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "操作失败" }, { status: 400 });
  }
}

async function listRecentEvents(taskId: string) {
  const { listTaskEvents } = await import("../../../../lib/tasks/repo");
  const events = await listTaskEvents(taskId);
  return events.slice(-100).map((event) => ({
    id: event.id,
    type: event.type,
    payload: event.payload,
    created_at: event.created_at
  }));
}
