type Entry = { count: number; resetAt: number };

declare global {
  // Best-effort protection for a warm server instance. Durable enforcement must
  // live at the deployment/provider layer.
  var __goAiRateLimits: Map<string, Entry> | undefined;
}

const store = globalThis.__goAiRateLimits ??= new Map<string, Entry>();
const MAX_RATE_LIMIT_ENTRIES = 10_000;
let operations = 0;

function clientIp(request: Request) {
  return (request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim() || "unknown";
}

export function configuredRequestLimit() {
  const value = Number(process.env.RATE_LIMIT_REQUESTS_PER_MINUTE || 30);
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 5), 300) : 30;
}

export function checkRateLimit(request: Request, scope: string, limit = configuredRequestLimit(), windowMs = 60_000) {
  const now = Date.now();
  operations += 1;
  if (operations % 256 === 0) pruneRateLimits();

  const requestedKey = `${scope}:${clientIp(request)}`;
  // Bound warm-instance memory even if a caller can continuously rotate the
  // forwarded address. New identities share a conservative overflow bucket
  // until existing windows expire.
  const key = store.has(requestedKey) || store.size < MAX_RATE_LIMIT_ENTRIES
    ? requestedKey
    : `${scope}:overflow`;
  const current = store.get(key);
  if (!current || current.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  current.count += 1;
  if (current.count <= limit) return { ok: true, retryAfter: 0 };
  return { ok: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
}

export function pruneRateLimits() {
  const now = Date.now();
  for (const [key, entry] of store) if (entry.resetAt <= now) store.delete(key);
}
