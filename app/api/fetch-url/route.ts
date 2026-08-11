import { NextResponse } from "next/server";
import { accessConfigurationError, isAuthorized } from "../../../lib/auth";
import { fetchUrls } from "../../../lib/exa";
import { HttpError, isRecord, readJsonBody } from "../../../lib/http";
import { checkRateLimit } from "../../../lib/rate-limit";
import { safePublicHttpUrl } from "../../../lib/urls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const configurationError = accessConfigurationError();
  if (configurationError) return NextResponse.json({ error: configurationError }, { status: 503 });
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rate = checkRateLimit(request, "fetch-url");
  if (!rate.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": String(rate.retryAfter) } });

  try {
    const body = await readJsonBody(request, 16_384);
    if (!isRecord(body) || !Array.isArray(body.urls) || body.urls.length === 0 || body.urls.length > 5) {
      throw new HttpError(400, "Provide 1 to 5 URLs");
    }
    const urls = body.urls.map((value) => safePublicHttpUrl(value));
    if (urls.some((url) => !url)) throw new HttpError(400, "Only public HTTP/HTTPS URLs are allowed");
    const result = await fetchUrls(urls as string[], request.signal);
    return NextResponse.json({ provider: "Exa MCP", ...result });
  } catch (error) {
    if (error instanceof HttpError) return NextResponse.json({ error: error.message }, { status: error.status });
    const message = error instanceof Error ? error.message : "URL fetch unavailable";
    return NextResponse.json({ error: "URL fetch unavailable" }, { status: /timed out/i.test(message) ? 504 : 502 });
  }
}
