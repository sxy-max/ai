import { NextResponse } from "next/server";
import { accessConfigurationError, isAuthorized } from "../../../lib/auth";
import { classifyTask, type ClassifyInput } from "../../../lib/taskRouter";
import { generateArtifact, isGeneratorKind } from "../../../lib/generators/registry";
import { artifactService } from "../../../lib/artifacts/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 任务分类 + Artifact 生成接口（Phase A 分类 → Phase F 执行）。
 * 对支持确定性生成的 artifact 任务（pptx/html/csv/markdown）直接产出文件，
 * 全程不依赖沙箱、不调用模型。
 *
 * POST /api/tasks
 * body: { message, attachments?, model?, settings? }
 * ok:   { ok: true, intent, artifacts?: ClientArtifact[] }
 * err:  { ok: false, error }
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

  if (intent.type === "artifact" && intent.artifactKind && isGeneratorKind(intent.artifactKind)) {
    try {
      const output = await generateArtifact(intent.artifactKind, { message: body.message });
      const artifact = artifactService.createArtifact({
        filename: output.filename,
        content: output.content,
        kind: output.kind,
        mimeType: output.mime,
        source: "artifact_task",
      });
      return NextResponse.json({ ok: true, intent, artifacts: [artifactService.serializeArtifactForClient(artifact)] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ ok: false, intent, error: `文件生成失败：${message}` }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, intent });
}
