import { NextResponse } from "next/server";
import { accessConfigurationError, isAuthorized } from "../../../lib/auth";
import { checkRateLimit } from "../../../lib/rate-limit";
import { toolRegistry } from "../../../lib/toolRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const confErr = accessConfigurationError();
  if (confErr) return NextResponse.json({ error: confErr }, { status: 503 });
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rate = checkRateLimit(request, "tools", 60);
  if (!rate.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const tools = toolRegistry.list().map((t) => ({
    id: t.id,
    name: t.name,
    capability: t.capability,
    description: t.description,
    enabled: t.enabled,
    builtin: t.builtin,
  }));
  return NextResponse.json({ tools });
}
