import { NextResponse } from "next/server";
import { sessionToken } from "../../../../lib/auth";
import { deleteSession } from "../../../../lib/db/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/logout：删除当前会话。 */
export async function POST(request: Request) {
  const token = sessionToken(request);
  if (token) await deleteSession(token).catch(() => {});
  const response = NextResponse.json({ ok: true });
  response.cookies.set({ name: "go_ai_session", value: "", httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
