import { NextResponse } from "next/server";
import { accessConfigurationError, isAuthorized } from "../../../../lib/auth";
import { artifactService } from "../../../../lib/artifacts/service";
import type { ArtifactKind, ArtifactSource } from "../../../../lib/artifacts/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONTENT = 500 * 1024;
const VALID_KINDS: ArtifactKind[] = ["html", "markdown", "csv", "json", "txt", "pptx", "zip", "code", "unknown"];
const VALID_SOURCES: ArtifactSource[] = ["chat", "artifact_task", "file_agent", "manual_upload"];

export async function POST(request: Request) {
  const confErr = accessConfigurationError();
  if (confErr) return NextResponse.json({ error: confErr }, { status: 503 });
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const filename = String(body?.filename || body?.name || "file").slice(0, 200);
  const content = typeof body?.content === "string" ? body.content : "";
  if (!content || content.length > MAX_CONTENT) {
    return NextResponse.json({ error: "内容无效或超过 500KB" }, { status: 400 });
  }
  const kind = VALID_KINDS.includes(body?.kind) ? (body.kind as ArtifactKind) : undefined;
  const source = VALID_SOURCES.includes(body?.source) ? (body.source as ArtifactSource) : undefined;
  const jobId = typeof body?.jobId === "string" ? body.jobId.slice(0, 64) : undefined;
  const messageId = typeof body?.messageId === "string" ? body.messageId.slice(0, 64) : undefined;
  const ttlMs = typeof body?.ttlMs === "number" && body.ttlMs > 0 ? body.ttlMs : undefined;

  try {
    const artifact = artifactService.createArtifact({
      filename,
      content,
      kind,
      mimeType: typeof body?.mime === "string" ? body.mime.slice(0, 100) : undefined,
      source,
      jobId,
      messageId,
      ttlMs,
    });
    return NextResponse.json(artifactService.serializeArtifactForClient(artifact));
  } catch {
    return NextResponse.json({ error: "保存失败" }, { status: 500 });
  }
}
