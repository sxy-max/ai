import { NextResponse } from "next/server";
import { currentUser } from "../../../lib/auth";
import { query } from "../../../lib/db/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/files — 我的文件（PRD §30 文件系统）：上传来源 + 所属任务/产物下载链接。 */
export async function GET(request: Request) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || 100), 200);

  const result = await query<Record<string, unknown>>(
    `SELECT f.id, f.filename, f.mime, f.size, f.source, f.created_at,
       t.id AS task_id, t.title AS task_title
     FROM files f
     LEFT JOIN tasks t ON t.id = f.task_id
     WHERE f.user_id = $1
     ORDER BY f.created_at DESC LIMIT $2`,
    [user.id, limit]
  );
  const files = result.rows.map((row) => ({
    id: String(row.id),
    filename: String(row.filename),
    mime: String(row.mime || ""),
    size: Number(row.size || 0),
    source: String(row.source || "upload"),
    created_at: row.created_at,
    task_id: row.task_id ? String(row.task_id) : null,
    task_title: row.task_title ? String(row.task_title) : null,
    downloadUrl: `/api/artifacts/${row.id}`
  }));
  return NextResponse.json({ ok: true, files });
}
