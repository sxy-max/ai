import { NextResponse } from "next/server";
import { accessConfigurationError, createSessionToken, isAuthorized, passwordMatches, SESSION_COOKIE, SESSION_TTL_SECONDS } from "../../../lib/auth";
import { HttpError, isRecord, readJsonBody } from "../../../lib/http";
import { checkRateLimit } from "../../../lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorizedResponse(request: Request) {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: createSessionToken(),
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS
  });
  return response;
}

export async function POST(request: Request) {
  const configurationError = accessConfigurationError();
  if (configurationError) return NextResponse.json({ ok: false, error: configurationError }, { status: 503 });
  if (isAuthorized(request)) return authorizedResponse(request);
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
    return authorizedResponse(request);
  } catch (error) {
    if (error instanceof HttpError) return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    return NextResponse.json({ ok: false, error: "Authentication failed" }, { status: 500 });
  }
}
