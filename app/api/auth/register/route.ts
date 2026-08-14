import { NextResponse } from "next/server";
import {
  accessConfigurationError,
  attachSessionCookie,
  createUserSessionToken,
  passwordMatches,
  sessionToken
} from "../../../../lib/auth";
import { createSession, findUserBySession } from "../../../../lib/db/sessions";
import { createUser, findUserByEmail, userCount } from "../../../../lib/db/users";
import { HttpError, isRecord, readJsonBody } from "../../../../lib/http";
import { checkRateLimit } from "../../../../lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** POST /api/auth/register：注册（inviteCode = ACCESS_PASSWORD，首个用户为 admin）。 */
export async function POST(request: Request) {
  const configurationError = accessConfigurationError();
  if (configurationError) return NextResponse.json({ ok: false, error: configurationError }, { status: 503 });

  const rate = checkRateLimit(request, "register", 5, 60 * 60_000);
  if (!rate.ok) {
    return NextResponse.json({ ok: false, error: "注册太频繁，请稍后再试" }, {
      status: 429,
      headers: { "retry-after": String(rate.retryAfter) }
    });
  }

  try {
    const raw = await readJsonBody(request, 8_192);
    if (!isRecord(raw)) return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
    const email = typeof raw.email === "string" ? raw.email.trim() : "";
    const password = typeof raw.password === "string" ? raw.password : "";
    const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
    const inviteCode = typeof raw.inviteCode === "string" ? raw.inviteCode : "";

    if (!EMAIL_RE.test(email) || email.length > 256) {
      return NextResponse.json({ ok: false, error: "请输入有效的邮箱地址" }, { status: 400 });
    }
    if (password.length < 8 || password.length > 128) {
      return NextResponse.json({ ok: false, error: "密码长度需在 8-128 位之间" }, { status: 400 });
    }
    if (displayName.length > 32) {
      return NextResponse.json({ ok: false, error: "昵称最长 32 个字符" }, { status: 400 });
    }

    // 邀请码 = ACCESS_PASSWORD（生产必需；未配置时仅限开发环境）
    const configured = process.env.ACCESS_PASSWORD || "";
    if (configured) {
      if (!passwordMatches(inviteCode)) {
        return NextResponse.json({ ok: false, error: "邀请码不正确" }, { status: 401 });
      }
    } else if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ ok: false, error: "服务未配置注册邀请码" }, { status: 503 });
    }

    if (await findUserByEmail(email)) {
      return NextResponse.json({ ok: false, error: "该邮箱已注册" }, { status: 409 });
    }

    const isFirst = (await userCount()) === 0;
    const user = await createUser({ email, displayName, password, role: isFirst ? "admin" : "user" });
    const token = createUserSessionToken(user.id);
    await createSession(token, user.id);

    const response = NextResponse.json({ ok: true, user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role } });
    attachSessionCookie(response, token, request);
    return response;
  } catch (error) {
    if (error instanceof HttpError) return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    return NextResponse.json({ ok: false, error: "注册失败" }, { status: 500 });
  }
}
