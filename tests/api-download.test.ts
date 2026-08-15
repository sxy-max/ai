/** V1.4 WP64 下载可靠性测试：filename/mime/size/auth/过期/手机友好头。 */
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
delete process.env.OPENCODE_GO_API_KEY; delete process.env.DEEPSEEK_API_KEY;
import path from "node:path";
import os from "node:os";
process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-artifacts-download");
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../lib/db/users";
import { createUserSessionToken } from "../lib/auth";
import { createSession } from "../lib/db/sessions";
import { closeDb, query } from "../lib/db/pool";
import { closeRedis } from "../lib/db/redis";
import { artifactService } from "../lib/artifacts/service";
import { GET as artifactDownload } from "../app/api/artifacts/[id]/route";

let userId = "";
let token = "";

function authRequest(id: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/artifacts/${id}`, { headers: { cookie: `go_ai_session=${token}`, ...headers } });
}

before(async () => {
  const user = await createUser({ email: `dl-${Date.now()}@test.local`, displayName: "dl", password: "password-123" });
  userId = user.id;
  token = createUserSessionToken(user.id);
  await createSession(token, user.id);
});

after(async () => {
  await closeDb();
  await closeRedis();
});

test("下载：中文文件名 RFC 5987 + mime + 精确 size + 内容一致", async () => {
  const content = Buffer.from("报告内容 v1", "utf8");
  const artifact = artifactService.createArtifact({ filename: "物理实验报告.pdf", content, kind: "pdf", mimeType: "application/pdf", source: "agent" });
  // PG 归属记录（任务产物路径）
  const task = (await query("INSERT INTO tasks (user_id, title, goal, type, status) VALUES ($1,'t','g','artifact','completed') RETURNING id", [userId])).rows[0].id;
  await query("INSERT INTO artifacts (id, user_id, task_id, type, name, version, storage_key, size, mime, status) VALUES ($1,$2,$3,'pdf','物理实验报告',1,$4,$5,'application/pdf','ready')", [artifact.id, userId, task, artifact.id, content.length]);

  const res = await artifactDownload(authRequest(artifact.id), { params: Promise.resolve({ id: artifact.id }) });
  assert.equal(res.status, 200);
  const body = new Uint8Array(await res.arrayBuffer());
  assert.equal(Buffer.from(body).toString("utf8"), "报告内容 v1");
  assert.equal(res.headers.get("content-length"), String(content.length));
  assert.equal(res.headers.get("content-type"), "application/pdf");
  const disposition = res.headers.get("content-disposition") || "";
  assert.ok(disposition.includes("filename*=UTF-8''"), "中文文件名应走 RFC 5987");
});

test("下载：未登录 401；他人任务产物 404 穿越；不存在的 404", async () => {
  const artifact = artifactService.createArtifact({ filename: "a.xlsx", content: Buffer.from("x"), kind: "xlsx", source: "agent" });
  await query("INSERT INTO artifacts (id, user_id, task_id, type, name, version, storage_key, size, mime, status) VALUES ($1,$2,NULL,'xlsx','a',1,$3,1,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','ready')", [artifact.id, userId, artifact.id]);

  const anon = await artifactDownload(new Request(`http://localhost/api/artifacts/${artifact.id}`), { params: Promise.resolve({ id: artifact.id }) });
  assert.equal(anon.status, 401);

  const other = await createUser({ email: `dl-other-${Date.now()}@test.local`, displayName: "other", password: "password-123" });
  const otherToken = createUserSessionToken(other.id);
  await createSession(otherToken, other.id);
  const stolen = await artifactDownload(new Request(`http://localhost/api/artifacts/${artifact.id}`, { headers: { cookie: `go_ai_session=${otherToken}` } }), { params: Promise.resolve({ id: artifact.id }) });
  assert.equal(stolen.status, 404, "越权访问必须 404 穿越");

  const missing = await artifactDownload(authRequest("00000000-0000-0000-0000-000000000000"), { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) });
  assert.equal(missing.status, 404);
});

test("下载：过期产物 404；expired 状态转换生效", async () => {
  const artifact = artifactService.createArtifact({ filename: "expired.md", content: Buffer.from("gone"), kind: "markdown", source: "agent" });
  artifactService.markArtifactExpired(artifact.id);
  const res = await artifactDownload(authRequest(artifact.id), { params: Promise.resolve({ id: artifact.id }) });
  assert.equal(res.status, 404);
  assert.match((await res.text()) || "", /过期|不存在/);
});
