import { NextResponse } from "next/server";
import { accessConfigurationError, isAuthorized } from "../../../lib/auth";
import { classifyTask, type ClassifyInput } from "../../../lib/taskRouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 任务分类接口（Phase A）：只返回分类结果，不执行任何任务。
 * 不调用模型、不调用 File Agent、不生成 Artifact。
 *
 * POST /api/tasks
 * body: { message, attachments, model?, settings? }
 * ok:   { ok: true, intent: TaskIntent }
 * err:  { ok: false, error: string }
 */
export async function POST(request: Request) {
  const confErr = accessConfigurationError();
  if (confErr) return NextResponse.json({ ok: false, error: confErr }, { status: 503 });
  if (!isAuthorized(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body.message !== "string") {
    return NextResponse.json({ ok: false, error: "message 必填" }, { status: 400 });
  }

  const input: ClassifyInput = {
    message: body.message,
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
    model: body.model && typeof body.model === "object" ? body.model : undefined,
    settings: body.settings && typeof body.settings === "object" ? body.settings : undefined,
  };

  const intent = classifyTask(input);
  if (!intent) {
    return NextResponse.json({ ok: false, error: "空输入且无附件，无可分类内容" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, intent });
}
