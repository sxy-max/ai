import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Provider } from "./opencode";
import { findUserByEmail, findUserById, type UserRow } from "./db/users";
import { findUserBySession } from "./db/sessions";

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

/** 多用户会话：payload 携带 uid。 */
export function createUserSessionToken(userId: string) {
  const encoded = encodePayload({
    uid: userId,
    iat: Math.floor(Date.now() / 1000),
    nonce: randomBytes(12).toString("base64url")
  });
  return `${encoded}.${signEncoded(encoded, "session")}`;
}

/** 兼容旧测试/调用：无 uid 的会话 token（不用于生产登录）。 */
export function createSessionToken() {
  return createUserSessionToken("");
}

export type SessionPayload = { uid?: string; iat?: number; nonce?: string };

export function decodeSessionToken(token: string): SessionPayload | null {
  const payload = decodePayload<SessionPayload>(token, "session");
  if (!payload || typeof payload.iat !== "number") return null;
  const age = Math.floor(Date.now() / 1000) - payload.iat;
  if (age < -60 || age > SESSION_TTL_SECONDS) return null;
  return payload;
}

export function verifySessionToken(token: string) {
  return decodeSessionToken(token) !== null;
}

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
};

export function toAuthUser(row: UserRow): AuthUser {
  return { id: row.id, email: row.email, displayName: row.display_name, role: row.role };
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
  // 本地 E2E 测试模式: 仅非 production 生效
  if (process.env.E2E_MODE === "1" && process.env.NODE_ENV !== "production") return true;
  const configured = configuredPassword();
  if (!configured && process.env.NODE_ENV !== "production") return true;
  const headerPassword = request.headers.get("x-access-password");
  if (headerPassword != null && passwordMatches(headerPassword)) return true;
  const payload = decodeSessionToken(cookieValue(request, SESSION_COOKIE));
  return payload !== null && Boolean(payload.uid);
}

/** 完整鉴权：签名 + uid + PG 会话 + 用户有效。null = 未登录。 */
export async function currentUser(request: Request): Promise<AuthUser | null> {  if (accessConfigurationError()) return null;
  if (process.env.E2E_MODE === "1" && process.env.NODE_ENV !== "production") {
    // 测试模式：返回库中第一个用户（测试数据已存在）
    const first = await findUserByEmail("owner@local");
    if (first) return toAuthUser(first);
    return { id: "e2e-user", email: "e2e@local", displayName: "E2E", role: "admin" };
  }
  const configured = configuredPassword();
  if (!configured && process.env.NODE_ENV !== "production") return null;
  const token = cookieValue(request, SESSION_COOKIE);
  const payload = decodeSessionToken(token);
  if (!payload?.uid) return null;
  const bound = await findUserBySession(token);
  if (!bound || bound.id !== payload.uid) return null;
  const row = await findUserById(bound.id);
  if (!row) return null;
  return toAuthUser(row);
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

/** 写入 HttpOnly 会话 cookie（登录/注册成功后调用）。 */
export function attachSessionCookie(response: import("next/server").NextResponse, token: string, request: Request) {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS
  });
}

/** 会话 cookie 值（未登录返回空串）。 */
export function sessionToken(request: Request) {
  return cookieValue(request, SESSION_COOKIE);
}
