import { NextResponse } from "next/server";
import { accessConfigurationError, currentUser } from "../../../../lib/auth";
import { artifactService } from "../../../../lib/artifacts/service";
import { contentDisposition } from "../../../../lib/artifacts/metadata";
import { query } from "../../../../lib/db/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/artifacts/:id — 认证下载。
 * 归属校验：PG artifacts 表有记录的（任务产物）必须属于当前用户，否则 404 穿越；
 * 无记录（v7 旧版磁盘产物）保持「仅登录」兼容。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const confErr = accessConfigurationError();
  if (confErr) return NextResponse.json({ error: confErr }, { status: 503 });
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!String(id || "").trim()) return NextResponse.json({ error: "缺少 artifact id" }, { status: 400 });

  // 任务产物（PG 登记过）→ 归属校验（404 穿越，不泄露存在性）
  const row = await query<{ user_id: string }>("SELECT user_id FROM artifacts WHERE id = $1", [id]).catch(() => ({ rows: [] as Array<{ user_id: string }> }));
  if (row.rows.length > 0) {
    if (row.rows[0].user_id !== user.id) return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }

  const artifact = artifactService.getArtifact(id);
  if (!artifact) return NextResponse.json({ error: "文件不存在或已过期" }, { status: 404 });
  if (artifact.status === "expired") return NextResponse.json({ error: "文件已过期" }, { status: 404 });

  const buf = artifactService.readContent(artifact.id);
  if (!buf) return NextResponse.json({ error: "文件缺失" }, { status: 404 });

  const safeName = contentDisposition(artifact.filename);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": artifact.mimeType,
      "content-disposition": safeName,
      "content-length": String(buf.length),
    },
  });
}
