import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Provider } from "./opencode";

export const SESSION_COOKIE = "go_ai_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MODEL_TOKEN_TTL_SECONDS = SESSION_TTL_SECONDS;

const PLACEHOLDER_PASSWORDS = new Set([
  "share_this_password_with_your_friend",
  "your_friend_login_password",
  "给朋友的密码"
]);

function configuredPassword() {
  return process.env.ACCESS_PASSWORD || "";
}

export function accessConfigurationError() {
  if (process.env.NODE_ENV !== "production") return null;
  const password = configuredPassword();
  if (!password) return "ACCESS_PASSWORD is required in production";
  if (PLACEHOLDER_PASSWORDS.has(password)) return "ACCESS_PASSWORD still uses an example value";
  if (password.length < 12) return "ACCESS_PASSWORD must contain at least 12 characters";
  return null;
}

function sessionSigningSecret() {
  const password = configuredPassword();
  return password || "go-ai-development-only-secret";
}

function modelSigningSecret() {
  const configured = process.env.MODEL_TOKEN_SECRET || "";
  if (configured) return configured;
  const providerKeyMaterial = [
    "opencode-go",
    process.env.OPENCODE_GO_API_KEY || "",
    "anthropic",
    process.env.ANTHROPIC_API_KEY || ""
  ].join("\0");
  return createHmac("sha256", "go-ai-model-token-provider-derivation-v1")
    .update(providerKeyMaterial)
    .digest();
}

function digest(value: string, purpose: string, secret: string | Buffer = sessionSigningSecret()) {
  return createHmac("sha256", secret).update(`${purpose}\0${value}`).digest();
}

function safeDigestEqual(a: Buffer, b: Buffer) {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export function passwordMatches(candidate: string) {
  if (accessConfigurationError()) return false;
  const configured = configuredPassword();
  if (!configured) return process.env.NODE_ENV !== "production";
  return safeDigestEqual(digest(candidate, "password"), digest(configured, "password"));
}

function signEncoded(encoded: string, purpose: string, secret?: string | Buffer) {
  return digest(encoded, purpose, secret).toString("base64url");
}

function encodePayload(payload: unknown) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload<T>(token: string, purpose: string, secret?: string | Buffer): T | null {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = Buffer.from(signEncoded(encoded, purpose, secret), "utf8");
  const received = Buffer.from(signature, "utf8");
  if (!safeDigestEqual(expected, received)) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function createSessionToken() {
  const encoded = encodePayload({
    iat: Math.floor(Date.now() / 1000),
    nonce: randomBytes(12).toString("base64url")
  });
  return `${encoded}.${signEncoded(encoded, "session")}`;
}

export function verifySessionToken(token: string) {
  const payload = decodePayload<{ iat?: unknown }>(token, "session");
  if (!payload || typeof payload.iat !== "number") return false;
  const age = Math.floor(Date.now() / 1000) - payload.iat;
  return age >= -60 && age <= SESSION_TTL_SECONDS;
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

export function isAuthorized(request: Request) {
  if (accessConfigurationError()) return false;
  const configured = configuredPassword();
  if (!configured && process.env.NODE_ENV !== "production") return true;
  const headerPassword = request.headers.get("x-access-password");
  if (headerPassword != null && passwordMatches(headerPassword)) return true;
  return verifySessionToken(cookieValue(request, SESSION_COOKIE));
}

export function signModelAccess(provider: Provider, model: string) {
  const encoded = encodePayload({
    provider,
    model,
    exp: Math.floor(Date.now() / 1000) + MODEL_TOKEN_TTL_SECONDS
  });
  return `${encoded}.${signEncoded(encoded, modelPolicyPurpose(), modelSigningSecret())}`;
}

export function verifyModelAccess(token: string, provider: Provider, model: string) {
  const payload = decodePayload<{ provider?: unknown; model?: unknown; exp?: unknown }>(token, modelPolicyPurpose(), modelSigningSecret());
  if (!payload || payload.provider !== provider || payload.model !== model || typeof payload.exp !== "number") return false;
  return payload.exp >= Math.floor(Date.now() / 1000);
}

function modelPolicyPurpose() {
  return [
    "model",
    process.env.ALLOW_OTHER_MODELS || "false",
    process.env.FEATURED_MODELS || "",
    process.env.ANTHROPIC_FEATURED_MODELS || ""
  ].join("\0");
}
