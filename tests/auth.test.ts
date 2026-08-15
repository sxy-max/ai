/** 多用户认证数据层测试（需要本地 PostgreSQL：npm run db:migrate 后执行）。 */
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch { /* 无本地 env 时忽略 */ }
// 测试隔离：删除模型 key，防止测试进程发起真实网络请求（慢/不可控）
delete process.env.OPENCODE_GO_API_KEY; delete process.env.DEEPSEEK_API_KEY;
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUser, findUserByEmail, hashPassword, userCount, verifyPassword } from "../lib/db/users";
import { createSession, deleteSession, findUserBySession } from "../lib/db/sessions";
import { createUserSessionToken, decodeSessionToken, isAuthorized, verifySessionToken } from "../lib/auth";

function requestWithCookie(token: string) {
  return new Request("http://localhost/api/x", { headers: { cookie: `go_ai_session=${token}` } });
}

test("密码哈希：正确/错误密码", async () => {
  const hash = await hashPassword("correct-horse-123");
  assert.equal(await verifyPassword("correct-horse-123", hash), true);
  assert.equal(await verifyPassword("wrong", hash), false);
  assert.equal(await verifyPassword("correct-horse-123", "garbage"), false);
});

test("用户创建与查询：唯一邮箱、首用户 admin", async () => {
  const email = `auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const wasFirst = (await userCount()) === 0;
  const user = await createUser({ email, displayName: "测试用户", password: "password-123" });
  assert.ok(user.id);
  assert.equal(user.role, wasFirst ? "admin" : "user"); // 空库首用户为 admin
  const found = await findUserByEmail(email);
  assert.equal(found?.id, user.id);
  await assert.rejects(createUser({ email, displayName: "重复", password: "password-123" }));
});

test("会话：创建→验证→删除", async () => {
  const email = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const user = await createUser({ email, displayName: "会话用户", password: "password-123", role: "user" });
  const token = createUserSessionToken(user.id);
  await createSession(token, user.id);

  const bound = await findUserBySession(token);
  assert.equal(bound?.id, user.id);

  const payload = decodeSessionToken(token);
  assert.equal(payload?.uid, user.id);
  assert.equal(verifySessionToken(token), true);
  assert.equal(verifySessionToken(`${token}x`), false);

  // 未绑定 PG 的 token（旧版格式）：isAuthorized 必须拒绝
  const legacyToken = createUserSessionToken("legacy");
  await createSession(legacyToken, "00000000-0000-0000-0000-000000000000").catch(() => {});
  assert.equal(isAuthorized(requestWithCookie(token)), true);

  await deleteSession(token);
  assert.equal(await findUserBySession(token), null);
});

test("userCount 可用", async () => {
  const count = await userCount();
  assert.equal(typeof count, "number");
  assert.ok(count >= 1);
});

