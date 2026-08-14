import { NextResponse } from "next/server";
import { attachSessionCookie, createUserSessionToken, sessionToken } from "../../../../lib/auth";
import { createSession, findUserBySession } from "../../../../lib/db/sessions";
import { findUserByEmail, verifyPassword } from "../../../../lib/db/users";
import { HttpError, isRecord, readJsonBody } from "../../../../lib/http";
import { checkRateLimit } from "../../../../lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/login：邮箱+密码登录，返回 HttpOnly 会话 cookie。 */
export async function POST(request: Request) {
  const rate = checkRateLimit(request, "login", 10, 5 * 60_000);
  if (!rate.ok) {
    return NextResponse.json({ ok: false, error: "登录尝试过于频繁，请稍后再试" }, {
      status: 429,
      headers: { "retry-after": String(rate.retryAfter) }
    });
  }

  try {
    const raw = await readJsonBody(request, 8_192);
    if (!isRecord(raw)) return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
    const email = typeof raw.email === "string" ? raw.email.trim() : "";
    const password = typeof raw.password === "string" ? raw.password : "";

    const user = await findUserByEmail(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return NextResponse.json({ ok: false, error: "邮箱或密码错误" }, { status: 401 });
    }

    const token = createUserSessionToken(user.id);
    await createSession(token, user.id);
    const response = NextResponse.json({ ok: true, user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role } });
    attachSessionCookie(response, token, request);
    return response;
  } catch (error) {
    if (error instanceof HttpError) return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    return NextResponse.json({ ok: false, error: "登录失败" }, { status: 500 });
  }
}
