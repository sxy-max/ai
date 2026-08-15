/** Project Workspace / Continuation 测试（V1.2 WP24-26）。 */
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
// 测试隔离：删除模型 key，防止测试进程发起真实网络请求
delete process.env.OPENCODE_GO_API_KEY; delete process.env.DEEPSEEK_API_KEY;
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../../lib/db/users";
import { query, closeDb } from "../../lib/db/pool";
import { closeRedis } from "../../lib/db/redis";
import { createTask, continueTask, getTask } from "../../lib/tasks/repo";
import { listProjectArtifactSummary } from "../../lib/tasks/worker";
import { registerTaskArtifact } from "../../lib/tasks/artifacts";

let userId = "";

before(async () => {
  const user = await createUser({ email: `project-ctx-${Date.now()}@test.local`, displayName: "project-ctx", password: "password-123" });
  userId = user.id;
});

after(async () => {
  await closeDb();
  await closeRedis();
});

test("WP26：项目历史产物进入 planner 上下文（多轮任务知道上轮交付）", async () => {
  const project = await query<{ id: string }>(
    `INSERT INTO projects (name, user_id) VALUES ('网站项目', $1) RETURNING id`,
    [userId]
  );
  const projectId = project.rows[0].id;

  // 任务 A（绑定项目）：完成并交付 index.html v1
  const taskA = await createTask({ userId, projectId, goal: "做一个网站首页", title: "首页" });
  await registerTaskArtifact({ taskId: taskA.id, userId, projectId, filename: "index.html", name: "index", kind: "html", content: "<html>v1</html>" });

  // 任务 B（同项目）：应看到上轮产物
  const taskB = await createTask({ userId, projectId, goal: "颜色再浅一点", title: "调整" });
  const summary = await listProjectArtifactSummary(projectId);
  assert.match(summary, /index v1（html）/, "项目上下文应含上轮交付产物");

  // 任务 B 绑定同一项目（lineage 一致）
  const b = await getTask(taskB.id);
  assert.equal(b?.project_id, projectId);
});

test("WP25：continueTask 原地续跑（同一任务 + 产物版本化 lineage）", async () => {
  const task = await createTask({ userId, goal: "写一篇文章", title: "文章" });
  await registerTaskArtifact({ taskId: task.id, userId, filename: "文章.md", name: "文章", kind: "markdown", content: "v1" });
  await query("UPDATE tasks SET status = 'completed' WHERE id = $1", [task.id]);

  await continueTask(task.id, "把标题改成加粗");
  const updated = await getTask(task.id);
  assert.equal(updated?.status, "queued");
  assert.match(String(updated?.goal), /追加要求/);
  // parent_task_id 指向自身（原地续跑语义 = 任务延续）
  assert.equal(updated?.parent_task_id, task.id);

  // 第二轮产物 → v2（版本化保留历史）
  const v2 = await registerTaskArtifact({ taskId: task.id, userId, filename: "文章.md", name: "文章", kind: "markdown", content: "v2" });
  assert.equal(v2.version, 2);
  const all = await query<{ version: number }>("SELECT version FROM artifacts WHERE task_id = $1 ORDER BY version", [task.id]);
  assert.deepEqual(all.rows.map((r) => r.version), [1, 2]);
});
