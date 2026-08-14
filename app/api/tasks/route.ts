import { NextResponse } from "next/server";
import { currentUser } from "../../../lib/auth";
import { createTask, listTasks } from "../../../lib/tasks/repo";
import { HttpError, isRecord, readJsonBody } from "../../../lib/http";
import { artifactService } from "../../../lib/artifacts/service";
import { kindFromFilename } from "../../../lib/artifacts/mime";
import { query } from "../../../lib/db/pool";
import type { TaskRow } from "../../../lib/tasks/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 20;
const ALLOWED_EXT = new Set([
  ".html", ".css", ".js", ".ts", ".tsx", ".jsx", ".json", ".md", ".txt",
  ".py", ".sh", ".yaml", ".yml", ".csv", ".xml", ".svg", ".zip",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".xlsx", ".xls", ".docx", ".pptx", ".pdf"
]);

/**
 * Task API（PRD §63）：创建任务即入队，后台 Worker 执行，网页断开不影响。
 *
 * POST /api/tasks  JSON:      { goal, title?, projectId?, priority?, fileIds? }
 * POST /api/tasks  multipart: { goal, files[] }（文件落盘并注册到任务）
 * GET  /api/tasks  ?limit=&offset=
 */
export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  try {
    const contentType = request.headers.get("content-type") || "";
    let goal = "";
    let fileIds: string[] = [];
    let title: string | undefined;
    let projectId: string | null = null;
    let parentTaskId: string | null = null;
    let priority: "low" | "normal" | "high" = "normal";
    let rawType: "artifact" | "agent_workspace" | undefined = undefined;

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData().catch(() => null);
      if (!form) return NextResponse.json({ ok: false, error: "multipart/form-data 必填" }, { status: 400 });
      goal = String(form.get("goal") || "").trim();
      const typeRaw = String(form.get("type") || "");
      if (typeRaw === "artifact" || typeRaw === "agent_workspace") rawType = typeRaw;
      const files = form.getAll("files").filter((x): x is File => x instanceof File);
      if (files.length > MAX_FILES) return NextResponse.json({ ok: false, error: "一次最多 20 个文件" }, { status: 400 });
      for (const f of files) {
        const ext = f.name.includes(".") ? `.${f.name.split(".").pop()?.toLowerCase()}` : "";
        if (!ALLOWED_EXT.has(ext)) return NextResponse.json({ ok: false, error: `不支持的文件类型: ${ext}` }, { status: 400 });
        if (f.size > MAX_FILE_BYTES) return NextResponse.json({ ok: false, error: `${f.name} 超过 20MB` }, { status: 413 });
        const content = Buffer.from(await f.arrayBuffer());
        const artifact = artifactService.createArtifact({
          filename: f.name,
          content,
          mimeType: f.type || undefined,
          kind: kindFromFilename(f.name, f.type),
          source: "upload"
        });
        await query(
          `INSERT INTO files (id, user_id, filename, mime, size, storage_key, source)
           VALUES ($1, $2, $3, $4, $5, $6, 'upload')`,
          [artifact.id, user.id, artifact.filename, artifact.mimeType, artifact.size, artifact.id]
        );
        fileIds.push(artifact.id);
      }
    } else {
      const raw = await readJsonBody(request, 64 * 1024);
      if (!isRecord(raw)) return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
      goal = typeof raw.goal === "string" ? raw.goal.trim() : "";
      title = typeof raw.title === "string" ? raw.title : undefined;
      projectId = typeof raw.projectId === "string" ? raw.projectId : null;
      parentTaskId = typeof raw.parentTaskId === "string" ? raw.parentTaskId : null;
      priority = raw.priority === "low" || raw.priority === "high" ? raw.priority : "normal";
      rawType = raw.type === "agent_workspace" ? "agent_workspace" : raw.type === "artifact" ? "artifact" : undefined;
      fileIds = Array.isArray(raw.fileIds) ? raw.fileIds.filter((id): id is string => typeof id === "string") : [];
    }

    if (!goal) return NextResponse.json({ ok: false, error: "goal 必填" }, { status: 400 });
    if (goal.length > 20_000) return NextResponse.json({ ok: false, error: "目标过长" }, { status: 400 });

    const task = await createTask({
      userId: user.id,
      goal,
      title,
      projectId,
      parentTaskId,
      priority,
      type: rawType,
      fileIds: fileIds.length ? fileIds : undefined
    });
    return NextResponse.json({ ok: true, task: serializeTask(task) });
  } catch (error) {
    if (error instanceof HttpError) return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "任务创建失败" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
  const tasks = await listTasks(user.id, limit, offset);
  return NextResponse.json({ ok: true, tasks: tasks.map(serializeTask) });
}

export function serializeTask(task: TaskRow) {
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    status: task.status,
    type: task.type,
    priority: task.priority,
    progress: task.progress,
    current_stage: task.current_stage,
    project_id: task.project_id,
    plan: task.plan,
    result_summary: task.result_summary,
    error: task.error,
    artifact_count: (task as unknown as { artifact_count?: number }).artifact_count ?? null,
    steps_done: (task as unknown as { steps_done?: number }).steps_done ?? null,
    steps_total: (task as unknown as { steps_total?: number }).steps_total ?? null,
    created_at: task.created_at,
    started_at: task.started_at,
    completed_at: task.completed_at
  };
}
