import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/me：当前登录用户（401 = 未登录）。 */
export async function GET(request: Request) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  return NextResponse.json({ ok: true, user });
}
