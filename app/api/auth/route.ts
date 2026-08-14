import { NextResponse } from "next/server";
import {
  accessConfigurationError,
  attachSessionCookie,
  createUserSessionToken,
  isAuthorized,
  passwordMatches
} from "../../../lib/auth";
import { createSession } from "../../../lib/db/sessions";
import { createUser, findUserByEmail, userCount } from "../../../lib/db/users";
import { HttpError, isRecord, readJsonBody } from "../../../lib/http";
import { checkRateLimit } from "../../../lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 兼容路径：ACCESS_PASSWORD 登录 → 绑定/创建 owner 用户（PRD 迁移期）。 */
export async function POST(request: Request) {
  const configurationError = accessConfigurationError();
  if (configurationError) return NextResponse.json({ ok: false, error: configurationError }, { status: 503 });
  if (isAuthorized(request)) {
    // 已有有效会话：直接续期
    return NextResponse.json({ ok: true });
  }
  if (!request.body) return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });

  const rate = checkRateLimit(request, "auth", 10, 5 * 60_000);
  if (!rate.ok) {
    return NextResponse.json({ ok: false, error: "Too many login attempts" }, {
      status: 429,
      headers: { "retry-after": String(rate.retryAfter) }
    });
  }

  try {
    const raw = await readJsonBody(request, 4_096);
    if (!isRecord(raw) || typeof raw.password !== "string" || raw.password.length > 512 || !passwordMatches(raw.password)) {
      return NextResponse.json({ ok: false, error: "Invalid password" }, { status: 401 });
    }

    // 绑定到 owner 用户（首次自动创建，admin）
    let user = await findUserByEmail("owner@local");
    if (!user) {
      const isFirst = (await userCount()) === 0;
      user = await createUser({
        email: "owner@local",
        displayName: "Owner",
        password: `owner-${randomSuffix()}`,
        role: isFirst ? "admin" : "user"
      });
    }

    const token = createUserSessionToken(user.id);
    await createSession(token, user.id);
    const response = NextResponse.json({ ok: true });
    attachSessionCookie(response, token, request);
    return response;
  } catch (error) {
    if (error instanceof HttpError) return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    return NextResponse.json({ ok: false, error: "Authentication failed" }, { status: 500 });
  }
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}
