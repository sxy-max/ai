/** Project API 集成测试（V1.4 WP37-40）：创建/列表/详情（产物版本 + 文件树）+ 项目延续共享 workspace。 */
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
delete process.env.OPENCODE_GO_API_KEY; delete process.env.DEEPSEEK_API_KEY;
import path from "node:path";
import os from "node:os";
process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-artifacts-api-projects");
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createUser } from "../lib/db/users";
import { createUserSessionToken } from "../lib/auth";
import { createSession } from "../lib/db/sessions";
import { closeDb, query } from "../lib/db/pool";
import { artifactService } from "../lib/artifacts/service";
import { closeRedis } from "../lib/db/redis";
import { GET as projectsGet, POST as projectsPost } from "../app/api/projects/route";
import { GET as projectDetailGet } from "../app/api/projects/[id]/route";
import { runDevStep } from "../lib/tasks/devExecutor";
import type { AgentRuntimeAdapter } from "../lib/sandbox/adapter";

let userId = "";
let token = "";

function authRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { cookie: `go_ai_session=${token}`, ...(init.headers || {}) }
  });
}

before(async () => {
  const email = `api-projects-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const user = await createUser({ email, displayName: "api-projects", password: "password-123" });
  userId = user.id;
  token = createUserSessionToken(user.id);
  await createSession(token, user.id);
});

after(async () => {
  await closeDb();
  await closeRedis();
});

test("POST/GET /api/projects：创建 + 列表（他人项目不可见）", async () => {
  const created = await projectsPost(await authRequest("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "大学物理课程材料" }),
  }));
  assert.equal(created.status, 200);
  const body = (await created.json()) as { project: { id: string; name: string } };
  assert.ok(body.project.id);
  assert.equal(body.project.name, "大学物理课程材料");

  const list = await projectsGet(await authRequest("/api/projects"));
  const data = (await list.json()) as { projects: Array<{ id: string; name: string }> };
  assert.ok(data.projects.some((p) => p.id === body.project.id));

  // 他人用户看不到
  const other = await createUser({ email: `other-${Date.now()}@test.local`, displayName: "other", password: "password-123" });
  const otherToken = createUserSessionToken(other.id);
  await createSession(otherToken, other.id);
  const otherRes = await projectDetailGet(new Request(`http://localhost/api/projects/${body.project.id}`, {
    headers: { cookie: `go_ai_session=${otherToken}` },
  }), { params: Promise.resolve({ id: body.project.id }) });
  assert.equal(otherRes.status, 404);
});

test("GET /api/projects/:id：任务 + 产物历史（版本化）+ 文件树", async () => {
  const created = await projectsPost(await authRequest("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "网站项目" }),
  }));
  const { project } = (await created.json()) as { project: { id: string } };

  // 种子：项目下任务 + 两个版本产物（模拟 v1/v2）+ workspace 文件
  const task = await query("INSERT INTO tasks (user_id, project_id, title, goal, type, status) VALUES ($1, $2, $3, $4, 'agent_workspace', 'completed') RETURNING id", [userId, project.id, "背景改深色", "把网站背景改成深色"]);
  const taskId = String(task.rows[0].id);
  await query("INSERT INTO artifacts (user_id, task_id, project_id, type, name, version, storage_key, size, mime) VALUES ($1,$2,$3,'zip','site',1,'k1',10,'application/zip'),($1,$2,$3,'zip','site',2,'k2',20,'application/zip')", [userId, taskId, project.id]);

  const root = path.join(os.tmpdir(), "goai-proj-files");
  fs.mkdirSync(path.join(root, "projects", project.id, "input"), { recursive: true });
  fs.mkdirSync(path.join(root, "projects", project.id, "output"), { recursive: true });
  fs.writeFileSync(path.join(root, "projects", project.id, "input", "site.zip"), "zipdata");
  fs.writeFileSync(path.join(root, "projects", project.id, "output", "index.html"), "<h1>hi</h1>");
  const prev = process.env.WORKSPACES_ROOT;
  process.env.WORKSPACES_ROOT = root;

  try {
    const res = await projectDetailGet(await authRequest(`/api/projects/${project.id}`), { params: Promise.resolve({ id: project.id }) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { project: { name: string }; tasks: Array<{ id: string }>; artifacts: Array<{ name: string; version: number }>; files: Array<{ path: string; dir: boolean }> };
    assert.equal(body.project.name, "网站项目");
    assert.ok(body.tasks.some((t) => t.id === taskId));
    assert.equal(body.artifacts.length, 2, "两个版本产物");
    assert.ok(body.artifacts.some((a) => a.version === 2));
    assert.ok(body.files.some((f) => f.path === "input/site.zip"));
    assert.ok(body.files.some((f) => f.path === "output/index.html"));
    assert.ok(body.files.some((f) => f.dir && f.path === "input"));

  } finally {
    if (prev) process.env.WORKSPACES_ROOT = prev; else delete process.env.WORKSPACES_ROOT;
  }
});

test("项目延续（WP40）：两轮任务共享同一 workspace 根，input 不重复上传", async () => {
  const created = await projectsPost(await authRequest("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "延续项目" }),
  }));
  const { project } = (await created.json()) as { project: { id: string } };

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goai-proj-cont-"));
  const roots: string[] = [];
  let projectMode = false;
  // 真实 zip 内容（格式验证会校验容器）
  const { default: JSZip } = await import("jszip");
  const realZip = await new JSZip().file("index.html", "<h1>site</h1>").generateAsync({ type: "nodebuffer" }) as Buffer;
  const adapter: AgentRuntimeAdapter = {
    id: "test-fake",
    available: true,
    async prepare() { return { ok: true, detail: "fake" }; },
    async execute(request, onEvent) { return this.run!(request, onEvent); },
    async run(request, onEvent) {
      // 容器侧契约：{conversationId}/{jobId} → WORKSPACES_ROOT 下根目录
      const root = path.join(tmpRoot, String(request.job.conversationId), String(request.job.jobId));
      roots.push(root);
      projectMode = request.job.conversationId === "projects";
      const fs2 = await import("node:fs");
      const outDir = path.join(root, "output");
      fs2.mkdirSync(outDir, { recursive: true });
      const inputDir = path.join(root, "input");
      if (fs2.existsSync(inputDir)) {
        for (const f of fs2.readdirSync(inputDir)) {
          fs2.copyFileSync(path.join(inputDir, f), path.join(outDir, `done-${f}`));
        }
      }
      // 上报产物事件（真实 adapter 行为：name 为 workspace 相对路径；必须 await——runner 按序等待）
      const files = fs2.readdirSync(outDir).filter((n) => n.endsWith(".zip"));
      if (files.length) {
        await onEvent?.({
          type: "artifacts",
          files: files.map((n) => ({ name: `output/${n}`, mime: "application/zip" })),
        } as never);
      }
      return { ok: true, exitCode: 0, output: "fake done", artifactCount: files.length };
    },
    async collectOutputs(workspaceRoot: string) {
      const outDir = path.join(workspaceRoot, "output");
      const fs2 = await import("node:fs");
      if (!fs2.existsSync(outDir)) return [];
      return fs2.readdirSync(outDir).map((n) => ({ relPath: `output/${n}`, absPath: path.join(outDir, n), size: fs2.statSync(path.join(outDir, n)).size, isDir: false }));
    },
    async cancel() {},
    async cleanup() {},
  };

  const fileId = artifactService.createArtifact({ filename: "site.zip", content: realZip, kind: "zip", source: "upload" }).id;
  const task1 = (await query("INSERT INTO tasks (user_id, project_id, title, goal, type, status) VALUES ($1,$2,'背景改深色','把网站背景改成深色','agent_workspace','queued') RETURNING id", [userId, project.id])).rows[0].id;
  const task2 = (await query("INSERT INTO tasks (user_id, project_id, title, goal, type, status) VALUES ($1,$2,'标题调大','标题再大一点','agent_workspace','queued') RETURNING id", [userId, project.id])).rows[0].id;
  const baseInput = {
    taskId: String(task1), stepId: "s", userId, projectId: project.id,
    goal: "把网站背景改成深色", files: [{ id: String(fileId), filename: "site.zip" }],
    signal: new AbortController().signal,
    emit: async () => {},
  };

  // 第一轮：任务 1 上传 site.zip
  process.env.ENABLE_PROJECT_WS = "1";
  try {
    await runDevStep(baseInput, { adapter, workspacesRoot: tmpRoot });
    const ws1 = path.join(tmpRoot, "projects", project.id);
    assert.ok(fs.existsSync(path.join(ws1, "input", "site.zip")), "任务1 输入入 workspace");
    assert.ok(fs.existsSync(path.join(ws1, "output", "done-site.zip")), "任务1 输出产出");

    // 第二轮：任务 2 不重新上传（files 为空），应复用同一 workspace 根，且 input 仍保留
    await runDevStep({ ...baseInput, taskId: String(task2), goal: "标题再大一点", files: [] }, { adapter, workspacesRoot: tmpRoot });
    assert.equal(roots.length, 2);
    assert.equal(roots[0], roots[1], "两轮任务共享同一 workspace 根");
    assert.ok(fs.existsSync(path.join(ws1, "input", "site.zip")), "原材料不重复上传且保留（WP15）");
    assert.ok(fs.existsSync(path.join(ws1, "output", "done-site.zip")), "第一轮产物仍在");
  } finally {
    delete process.env.ENABLE_PROJECT_WS;
  }
});
