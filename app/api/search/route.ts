import { NextResponse } from "next/server";
import { accessConfigurationError, isAuthorized } from "../../../lib/auth";
import { searchWeb } from "../../../lib/exa";
import { HttpError, isRecord, readJsonBody } from "../../../lib/http";
import { checkRateLimit } from "../../../lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const configurationError = accessConfigurationError();
  if (configurationError) return NextResponse.json({ error: configurationError }, { status: 503 });
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rate = checkRateLimit(request, "search");
  if (!rate.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": String(rate.retryAfter) } });

  try {
    const body = await readJsonBody(request, 16_384);
    if (!isRecord(body) || typeof body.query !== "string") throw new HttpError(400, "Missing query");
    const query = body.query.trim();
    if (!query || query.length > 2_000) throw new HttpError(400, "Query must contain 1 to 2000 characters");
    const requestedResults = body.numResults == null ? 6 : body.numResults;
    if (typeof requestedResults !== "number" || !Number.isFinite(requestedResults)) throw new HttpError(400, "Invalid result count");
    const result = await searchWeb(query, Math.floor(requestedResults), request.signal);
    return NextResponse.json({ query, provider: "Exa MCP", ...result });
  } catch (error) {
    if (error instanceof HttpError) return NextResponse.json({ error: error.message }, { status: error.status });
    const message = error instanceof Error ? error.message : "Web search unavailable";
    return NextResponse.json({ error: "Web search unavailable" }, { status: /timed out/i.test(message) ? 504 : 502 });
  }
}
