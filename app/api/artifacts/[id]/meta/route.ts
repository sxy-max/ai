import { NextResponse } from "next/server";
import { accessConfigurationError, currentUser } from "../../../../../lib/auth";
import { artifactService } from "../../../../../lib/artifacts/service";
import { query } from "../../../../../lib/db/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/artifacts/:id/meta — 产物元数据（预览页用；归属校验同下载）。 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const confErr = accessConfigurationError();
  if (confErr) return NextResponse.json({ error: confErr }, { status: 503 });
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = (await params).id;
  if (!String(id || "").trim()) return NextResponse.json({ error: "缺少 artifact id" }, { status: 400 });

  const row = await query<{ user_id: string; task_id: string | null }>(
    "SELECT user_id, task_id FROM artifacts WHERE id = $1", [id]
  ).catch(() => ({ rows: [] as Array<{ user_id: string; task_id: string | null }> }));
  if (row.rows.length > 0) {
    if (row.rows[0].user_id !== user.id) return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }

  const artifact = artifactService.getArtifact(id);
  if (!artifact) return NextResponse.json({ error: "文件不存在或已过期" }, { status: 404 });
  return NextResponse.json({
    id: artifact.id,
    filename: artifact.filename,
    kind: artifact.kind,
    mime: artifact.mimeType,
    size: artifact.size,
    status: artifact.status,
    createdAt: artifact.createdAt,
    downloadUrl: `/api/artifacts/${artifact.id}`,
    taskId: row.rows[0]?.task_id ?? null
  });
}
