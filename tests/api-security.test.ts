/** 安全与并发测试：artifact 归属越权、并发领取唯一性。 */
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../lib/db/users";
import { createUserSessionToken } from "../lib/auth";
import { createSession } from "../lib/db/sessions";
import { query, closeDb } from "../lib/db/pool";
import { closeRedis } from "../lib/db/redis";

// 产物目录指向临时目录；必须在动态 import 之前设置（artifactService 单例在模块加载时读 env）
process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-artifacts-security-test");

let artifactGet: typeof import("../app/api/artifacts/[id]/route").GET;
let registerTaskArtifact: typeof import("../lib/tasks/artifacts").registerTaskArtifact;

let otherToken = "";

before(async () => {
  const other = await createUser({ email: `sec-other-${Date.now()}@test.local`, displayName: "other", password: "password-123" });
  otherToken = createUserSessionToken(other.id);
  await createSession(otherToken, other.id);
  const routeMod = await import("../app/api/artifacts/[id]/route");
  artifactGet = routeMod.GET;
  const artifactsMod = await import("../lib/tasks/artifacts");
  registerTaskArtifact = artifactsMod.registerTaskArtifact;
});

after(async () => {
  await closeDb();
  await closeRedis();
});

function req(token: string, path: string): Request {
  return new Request(`http://localhost${path}`, { headers: { cookie: `go_ai_session=${token}` } });
}

test("artifact 越权：他人产物 → 404 穿越；本人 → 200；未登录 → 401", async () => {
  const owner = await createUser({ email: `sec-owner2-${Date.now()}@test.local`, displayName: "owner2", password: "password-123" });
  const task = await query<{ id: string }>(
    `INSERT INTO tasks (user_id, goal, title, status) VALUES ($1, '越权测试', '越权测试', 'queued') RETURNING id`,
    [owner.id]
  );
  const artifact = await registerTaskArtifact({
    taskId: task.rows[0].id,
    userId: owner.id,
    filename: "机密.md",
    name: "机密",
    kind: "markdown",
    content: "这是只有主用户能看的内容"
  });
  const ownerToken = createUserSessionToken(owner.id);
  await createSession(ownerToken, owner.id);

  // 他人请求 → 404（不泄露存在性）
  const forbidden = await artifactGet(req(otherToken, `/api/artifacts/${artifact.id}`), { params: Promise.resolve({ id: artifact.id }) });
  assert.equal(forbidden.status, 404);

  // 本人请求 → 200 + 内容一致
  const ok = await artifactGet(req(ownerToken, `/api/artifacts/${artifact.id}`), { params: Promise.resolve({ id: artifact.id }) });
  assert.equal(ok.status, 200);
  const buf = Buffer.from(await ok.arrayBuffer());
  assert.equal(buf.toString("utf8"), "这是只有主用户能看的内容");

  // 未登录 → 401
  const anon = await artifactGet(new Request(`http://localhost/api/artifacts/${artifact.id}`), { params: Promise.resolve({ id: artifact.id }) });
  assert.equal(anon.status, 401);
});

test("并发领取：5 个任务同时 claim 无重复（FOR UPDATE SKIP LOCKED）", async () => {
  // 串行模式下清理全部残留 queued 任务（本测试库），保证 claim 集合恰好是本测试的 5 个
  await query("DELETE FROM tasks WHERE status = 'queued'");
  const user = await createUser({ email: `sec-claim-${Date.now()}@test.local`, displayName: "claim", password: "password-123" });
  const created: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await query<{ id: string }>(
      `INSERT INTO tasks (user_id, goal, title, status) VALUES ($1, $2, '并发', 'queued') RETURNING id`,
      [user.id, `并发领取 任务${i}`]
    );
    created.push(r.rows[0].id);
  }

  const claim = `UPDATE tasks
     SET status = 'planning', started_at = COALESCE(started_at, now()), updated_at = now()
     WHERE id = (
       SELECT id FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id`;
  const results = await Promise.all(Array.from({ length: 5 }, () => query<{ id: string }>(claim)));
  const claimed = results.map((r) => r.rows[0]?.id).filter(Boolean);
  assert.equal(new Set(claimed).size, claimed.length, "领取结果不得重复");
  assert.equal(claimed.length, 5, "5 个任务应全部被领取");
  assert.deepEqual(new Set(claimed), new Set(created), "领取集合应恰好等于全部任务");

  // 再领一次 → 空（无 queued 剩余）
  const extra = await query<{ id: string }>(claim);
  assert.equal(extra.rows.length, 0);
});
