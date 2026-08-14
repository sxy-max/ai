import { NextResponse } from "next/server";
import { currentUser } from "../../../lib/auth";
import { listNotifications, markNotificationsRead } from "../../../lib/tasks/notify";
import { isRecord, readJsonBody } from "../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/notifications?limit=30 — 我的通知（任务完成/失败等）。 */
export async function GET(request: Request) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || 30), 100);
  const notifications = await listNotifications(user.id, limit);
  return NextResponse.json({ ok: true, notifications });
}

/** POST /api/notifications/read — 标记已读（body: { ids?: string[] }，缺省全部已读）。 */
export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  const raw = await readJsonBody(request, 64 * 1024).catch(() => ({}));
  const ids = isRecord(raw) && Array.isArray(raw.ids) ? raw.ids.filter((id): id is string => typeof id === "string") : undefined;
  await markNotificationsRead(user.id, ids);
  return NextResponse.json({ ok: true });
}
