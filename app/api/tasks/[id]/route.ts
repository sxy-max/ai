import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
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

  const [steps, artifacts, events] = await Promise.all([
    getSteps(task.id),
    listTaskArtifacts(task.id),
    listRecentEvents(task.id)
  ]);

  return NextResponse.json({
    ok: true,
    task: serializeTask(task),
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
