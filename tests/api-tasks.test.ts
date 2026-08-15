/** Task API 集成测试：直接调用 Next.js 路由处理器 + 真实 PG（认证/归属/SSE）。 */
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
// 测试隔离：删除模型 key，防止测试进程发起真实网络请求（慢/不可控）
delete process.env.OPENCODE_GO_API_KEY; delete process.env.DEEPSEEK_API_KEY;
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../lib/db/users";
import { createUserSessionToken } from "../lib/auth";
import { createSession } from "../lib/db/sessions";
import { closeDb } from "../lib/db/pool";
import { closeRedis } from "../lib/db/redis";
import { POST as createTaskPost, GET as listTasksGet } from "../app/api/tasks/route";
import { GET as taskDetailGet, PATCH as taskDetailPatch } from "../app/api/tasks/[id]/route";
import { GET as taskEventsGet } from "../app/api/tasks/[id]/events/route";

let userId = "";
let token = "";

async function authRequest(path: string, init: RequestInit = {}): Promise<Request> {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { cookie: `go_ai_session=${token}`, ...(init.headers || {}) }
  });
}

before(async () => {
  const email = `api-tasks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const user = await createUser({ email, displayName: "api-tasks", password: "password-123" });
  userId = user.id;
  token = createUserSessionToken(user.id);
  await createSession(token, user.id);
});

after(async () => {
  await closeDb();
  await closeRedis();
});

test("POST /api/tasks 未登录 → 401", async () => {
  const res = await createTaskPost(new Request("http://localhost/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "做个总结" })
  }));
  assert.equal(res.status, 401);
});

test("POST /api/tasks 缺 goal → 400；合法 → queued", async () => {
  const bad = await createTaskPost(await authRequest("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  }));
  assert.equal(bad.status, 400);

  const res = await createTaskPost(await authRequest("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "整理一份销售数据表格", title: "表格任务" })
  }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; task: { id: string; status: string; title: string; type: string } };
  assert.equal(body.ok, true);
  assert.equal(body.task.status, "queued");
  assert.equal(body.task.title, "表格任务");
  assert.equal(body.task.type, "artifact", "默认任务类型应为 artifact");

  // agent_workspace 类型任务
  const ws = await createTaskPost(await authRequest("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "根据图片修改 HTML", type: "agent_workspace" })
  }));
  const wsBody = (await ws.json()) as { task: { type: string } };
  assert.equal(wsBody.task.type, "agent_workspace");
});

test("GET /api/tasks 只返回自己的任务", async () => {
  const marker = `列表标记-${Date.now()}`;
  const createdRes = await createTaskPost(await authRequest("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: marker })
  }));
  const created = (await createdRes.json()) as { task: { id: string; goal: string } };

  const other = await createUser({ email: `api-other-${Date.now()}@test.local`, displayName: "other", password: "password-123" });
  const otherToken = createUserSessionToken(other.id);
  await createSession(otherToken, other.id);

  // 本人列表包含标记任务
  const res = await listTasksGet(await authRequest("/api/tasks"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { tasks: Array<{ id: string; goal: string }> };
  assert.ok(body.tasks.some((t) => t.id === created.task.id && t.goal === marker), "自己的任务应出现在列表");

  // 他人列表不含该任务
  const otherRes = await listTasksGet(new Request("http://localhost/api/tasks", {
    headers: { cookie: `go_ai_session=${otherToken}` }
  }));
  const otherBody = (await otherRes.json()) as { tasks: Array<{ id: string }> };
  assert.ok(!otherBody.tasks.some((t) => t.id === created.task.id), "他人列表不应包含我的任务");
});

test("GET /api/tasks/:id 归属校验：他人任务 → 404", async () => {
  const other = await createUser({ email: `api-other2-${Date.now()}@test.local`, displayName: "other2", password: "password-123" });
  const otherToken = createUserSessionToken(other.id);
  await createSession(otherToken, other.id);
  const res = await createTaskPost(await authRequest("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "他人的任务" })
  }));
  const created = (await res.json()) as { task: { id: string } };

  // 用「他人」的会话请求主用户的任务 → 404（归属校验）
  const forbidden = await taskDetailGet(new Request(`http://localhost/api/tasks/${created.task.id}`, {
    headers: { cookie: `go_ai_session=${otherToken}` }
  }), { params: Promise.resolve({ id: created.task.id }) });
  assert.equal(forbidden.status, 404);
});

test("GET /api/tasks/:id 详情含 steps/artifacts/events；PATCH cancel 生效", async () => {
  const res = await createTaskPost(await authRequest("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "写一段简短说明" })
  }));
  const created = (await res.json()) as { task: { id: string } };
  const id = created.task.id;

  const detail = await taskDetailGet(await authRequest(`/api/tasks/${id}`), { params: Promise.resolve({ id }) });
  assert.equal(detail.status, 200);
  const body = (await detail.json()) as { task: { status: string }; steps: unknown[]; artifacts: unknown[]; events: unknown[] };
  assert.equal(body.task.status, "queued");
  assert.ok(Array.isArray(body.steps) && Array.isArray(body.artifacts) && Array.isArray(body.events));

  const patch = await taskDetailPatch(await authRequest(`/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "cancel" })
  }), { params: Promise.resolve({ id }) });
  assert.equal(patch.status, 200);
  const patched = (await patch.json()) as { task: { status: string } };
  assert.equal(patched.task.status, "cancelled");
});

test("SSE /api/tasks/:id/events：先发 retry 与既有事件；他人任务 404", async () => {
  const res = await createTaskPost(await authRequest("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "SSE 事件任务" })
  }));
  const created = (await res.json()) as { task: { id: string } };
  const id = created.task.id;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const streamRes = await taskEventsGet(await authRequest(`/api/tasks/${id}/events`, { signal: controller.signal }), { params: Promise.resolve({ id }) });
  assert.equal(streamRes.status, 200);
  assert.match(streamRes.headers.get("content-type") || "", /text\/event-stream/);

  const reader = streamRes.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < 6; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes("task.created")) break;
  }
  clearTimeout(timeout);
  try { await reader.cancel(); } catch {}

  assert.match(text, /retry: 2000/);
  assert.match(text, /event: task/);
  assert.match(text, /task\.created/);

  // 他人任务 → 404
  const other = await createUser({ email: `api-other3-${Date.now()}@test.local`, displayName: "other3", password: "password-123" });
  const otherToken = createUserSessionToken(other.id);
  await createSession(otherToken, other.id);
  const forbidden = await taskEventsGet(new Request(`http://localhost/api/tasks/${id}/events`, {
    headers: { cookie: `go_ai_session=${otherToken}` }
  }), { params: Promise.resolve({ id }) });
  assert.equal(forbidden.status, 404);
});

