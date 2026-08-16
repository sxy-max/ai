import { NextResponse } from "next/server";
import { currentUser } from "../../../lib/auth";
import { listProjects } from "../../../lib/projects/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/projects —— 当前用户项目列表（含任务/产物计数）。 */
export async function GET(request: Request) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const projects = await listProjects(user.id);
  return NextResponse.json({ ok: true, projects });
}

/** POST /api/projects —— 创建项目 {name, description?}。 */
export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const name = String(body?.name || "").trim().slice(0, 200);
  if (!name) return NextResponse.json({ error: "项目名不能为空" }, { status: 400 });
  const description = String(body?.description || "").slice(0, 2000);
  const { query } = await import("../../../lib/db/pool");
  const result = await query(
    "INSERT INTO projects (user_id, name, description) VALUES ($1, $2, $3) RETURNING id, name, description, created_at",
    [user.id, name, description]
  );
  const row = result.rows[0];
  return NextResponse.json({ ok: true, project: { id: String(row.id), name: String(row.name), description: String(row.description || ""), created_at: String(row.created_at) } });
}
