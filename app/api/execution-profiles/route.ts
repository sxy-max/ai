import { NextResponse } from "next/server";
import { accessConfigurationError, isAuthorized } from "../../../lib/auth";
import { executionProfiles, probeExecutionProfiles } from "../../../lib/execution-profiles";
import { checkRateLimit } from "../../../lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function denied(request: Request) {
  const configurationError = accessConfigurationError();
  if (configurationError) return NextResponse.json({ error: configurationError }, { status: 503 });
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}

export async function GET(request: Request) {
  const error = denied(request);
  if (error) return error;
  // E2E uses mock chat models and has no Claude gateway; production GETs still
  // perform the cached health probe so manual profile choices are truthful.
  const profiles = process.env.E2E_MODE === "1" ? executionProfiles() : await probeExecutionProfiles();
  return NextResponse.json({ profiles });
}

export async function POST(request: Request) {
  const error = denied(request);
  if (error) return error;
  const rate = checkRateLimit(request, "execution-profile-probe", 6);
  if (!rate.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": String(rate.retryAfter) } });
  return NextResponse.json({ profiles: await probeExecutionProfiles(true) });
}
