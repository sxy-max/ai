/** Task 系统测试（需要本地 PostgreSQL：npm run db:migrate 后执行）。 */
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
// 测试隔离：删除模型 key，防止测试进程发起真实网络请求（慢/不可控）
delete process.env.OPENCODE_GO_API_KEY; delete process.env.DEEPSEEK_API_KEY;
import os from "node:os";
import path from "node:path";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createUser, findUserByEmail } from "../lib/db/users";
import { canTransition, assertTransition } from "../lib/tasks/state";
import { query, closeDb } from "../lib/db/pool";
import { closeRedis } from "../lib/db/redis";

// 产物目录指向临时目录（before 中动态 import 确保 env 生效）
process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-artifacts-test");

let repo: typeof import("../lib/tasks/repo");
let worker: typeof import("../lib/tasks/worker");
let planner: typeof import("../lib/leader/planner");
let artifactMod: typeof import("../lib/tasks/artifacts");

before(async () => {
  [repo, worker, planner, artifactMod] = await Promise.all([
    import("../lib/tasks/repo"),
    import("../lib/tasks/worker"),
    import("../lib/leader/planner"),
    import("../lib/tasks/artifacts")
  ]);
});

after(async () => {
  await closeDb();
  await closeRedis();
});

const R = () => repo!;
const W = () => worker!;
const P = () => planner!;
const A = () => artifactMod!;

async function testUser(tag: string) {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  let user = await findUserByEmail(email);
  if (!user) user = await createUser({ email, displayName: tag, password: "password-123" });
  return user;
}

test("状态机：合法/非法迁移", () => {
  assert.equal(canTransition("queued", "planning"), true);
  assert.equal(canTransition("planning", "running"), true);
  assert.equal(canTransition("running", "waiting_user"), true);
  assert.equal(canTransition("waiting_user", "running"), true);
  assert.equal(canTransition("running", "paused"), true);
  assert.equal(canTransition("paused", "running"), true);
  assert.equal(canTransition("running", "completed"), true);
  assert.equal(canTransition("running", "failed"), true);
  assert.equal(canTransition("failed", "queued"), true);
  assert.equal(canTransition("cancelled", "queued"), true);
  assert.equal(canTransition("completed", "running"), false);
  assert.equal(canTransition("completed", "queued"), true); // continue 多轮语义
  assert.equal(canTransition("cancelled", "completed"), false);
  assert.throws(() => assertTransition("completed", "paused"));
});

test("Task 创建：queued + task.created 事件", async () => {
  const user = await testUser("task-create");
  const task = await R().createTask({ userId: user.id, goal: "分析这份材料并做总结", title: "测试任务" });
  assert.equal(task.status, "queued");
  assert.equal(task.title, "测试任务");
  const events = await R().listTaskEvents(task.id);
  assert.equal(events[0]?.type, "task.created");
});

test("Leader 规则规划：分析+表格+PPT 任务", () => {
  const plan = P().planFromRules(
    { goal: "分析这些资料，给我做一个总结，整理一份 Excel，做一个 PPT" } as unknown as Parameters<typeof import("../lib/leader/planner").planFromRules>[0],
    { files: [{ filename: "材料.md" }] }
  );
  const kinds = plan.map((step) => step.worker_type);
  assert.ok(kinds.includes("general"), "应有分析步骤");
  assert.ok(kinds.includes("artifact"), "应有产物步骤");
  const artifactGoals = plan.filter((s) => s.worker_type === "artifact").map((s) => s.goal.toLowerCase()).join(" ");
  assert.ok(artifactGoals.includes("xlsx") || artifactGoals.includes("表格"), "应有表格步骤");
  assert.ok(artifactGoals.includes("pptx") || artifactGoals.includes("ppt"), "应有 PPT 步骤");
  // seq 连续
  plan.forEach((step, index) => assert.equal(step.seq, index + 1));
});

test("agent_workspace 类型任务强制走 dev 工作区链（不按关键词兜底）", () => {
  const plan = P().planFromRules(
    { goal: "根据图片修改 HTML", type: "agent_workspace" } as unknown as Parameters<typeof import("../lib/leader/planner").planFromRules>[0],
    { files: [] }
  );
  assert.ok(plan.some((step) => step.worker_type === "dev"), "必须含 dev 工作区步骤");
  assert.ok(!plan.some((step) => step.worker_type === "artifact"), "不得兜底成 artifact 生成");
});

test("完整闭环：创建 → 规划 → 执行 → 产物 → 完成", async () => {
  const user = await testUser("task-loop");
  const task = await R().createTask({ userId: user.id, goal: "整理一份销售数据表格" });
  const signal = new AbortController().signal;
  await W().runTaskToEnd(task.id, signal);

  const done = await R().getTask(task.id);
  assert.equal(done?.status, "completed");
  assert.equal(done?.progress, 100);
  assert.ok(done?.plan?.length, "应有 plan");

  const steps = await R().getSteps(task.id);
  assert.ok(steps.length >= 1);
  assert.equal(steps[steps.length - 1].status, "completed");

  const artifacts = await A().listTaskArtifacts(task.id);
  assert.ok(artifacts.length >= 1);
  assert.equal(artifacts[0].type, "xlsx");

  // 事件链完整
  const events = await R().listTaskEvents(task.id);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("task.started"));
  assert.ok(types.includes("plan.created"));
  assert.ok(types.includes("step.started"));
  assert.ok(types.includes("artifact.created"));
  assert.ok(types.includes("step.completed"));
  assert.ok(types.includes("task.completed"));
});

test("暂停/恢复/取消/重试", async () => {
  const user = await testUser("task-control");
  const task = await R().createTask({ userId: user.id, goal: "写一段简短说明" });

  // 排队中取消
  await R().cancelTask(task.id);
  assert.equal((await R().getTask(task.id))?.status, "cancelled");

  // 重试 → queued
  await R().retryTask(task.id);
  assert.equal((await R().getTask(task.id))?.status, "queued");

  // 暂停（planning 状态可暂停）
  await R().updateTaskStatus(task.id, "planning");
  await R().pauseTask(task.id);
  assert.equal((await R().getTask(task.id))?.status, "paused");

  // 恢复
  await R().resumeTask(task.id);
  assert.equal((await R().getTask(task.id))?.status, "running");

  // 完成后不能再取消
  await R().updateTaskStatus(task.id, "completed");
  await assert.rejects(R().cancelTask(task.id));
});

test("产物版本化：同名第二次注册 version 递增", async () => {
  const user = await testUser("task-version");
  const task = await R().createTask({ userId: user.id, goal: "版本测试" });
  await A().registerTaskArtifact({ taskId: task.id, userId: user.id, filename: "报告.md", name: "报告", kind: "markdown", content: "v1 内容" });
  await A().registerTaskArtifact({ taskId: task.id, userId: user.id, filename: "报告.md", name: "报告", kind: "markdown", content: "v2 内容" });
  const artifacts = await A().listTaskArtifacts(task.id);
  assert.equal(artifacts.length, 2);
  const versions = artifacts.map((a) => a.version).sort();
  assert.deepEqual(versions, [1, 2]);
});

test("非法状态迁移被拒绝", async () => {
  const user = await testUser("task-illegal");
  const task = await R().createTask({ userId: user.id, goal: "迁移测试" });
  await assert.rejects(R().updateTaskStatus(task.id, "completed" as never));
});

test("继续任务：completed → continue → 追加要求重新执行（产物版本化）", async () => {
  const user = await testUser("task-continue");
  const task = await R().createTask({ userId: user.id, goal: "写一段简短说明" });
  const signal = new AbortController().signal;
  await W().runTaskToEnd(task.id, signal);
  assert.equal((await R().getTask(task.id))?.status, "completed");

  const mod = await import("../lib/tasks/repo");
  await mod.continueTask(task.id, "把标题加粗");
  const continued = await R().getTask(task.id);
  assert.equal(continued?.status, "queued");
  assert.match(continued?.goal || "", /追加要求/);

  await W().runTaskToEnd(task.id, signal);
  assert.equal((await R().getTask(task.id))?.status, "completed");
  const events = await R().listTaskEvents(task.id);
  assert.ok(events.some((e) => e.type === "task.continued"), "应有 task.continued 事件");
});

test("取消时收尾执行中的 agent run", async () => {
  const user = await testUser("task-cancel-run");
  const task = await R().createTask({ userId: user.id, goal: "取消测试" });
  const run = await query<{ id: string }>(
    `INSERT INTO agent_runs (task_id, worker_type, status) VALUES ($1, 'general', 'running') RETURNING id`,
    [task.id]
  );
  await R().cancelTask(task.id);
  const row = await query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [run.rows[0].id]);
  assert.equal(row.rows[0].status, "cancelled");
  const steps = await R().getSteps(task.id);
  assert.equal(steps.some((s) => s.status === "skipped"), false, "无步骤时应无 skipped 标记");
});

test("崩溃恢复：租约过期的 planning/running 任务被回收重新入队", async () => {
  const user = await testUser("task-recover");
  const task = await R().createTask({ userId: user.id, goal: "恢复测试" });
  await query(
    `UPDATE tasks SET status = 'running', worker_id = 'dead-worker', lease_expires = now() - interval '1 second' WHERE id = $1`,
    [task.id]
  );
  // 模拟执行中的步骤与 run
  await R().createSteps(task.id, [{ seq: 1, worker_type: "general", title: "步骤1", goal: "目标" }]);
  await query("UPDATE task_steps SET status = 'running' WHERE task_id = $1", [task.id]);
  const run = await query<{ id: string }>(
    `INSERT INTO agent_runs (task_id, worker_type, status) VALUES ($1, 'general', 'running') RETURNING id`,
    [task.id]
  );

  const workerMod = await import("../lib/tasks/worker");
  const recovered = await workerMod.recoverOrphanedTasks();
  assert.equal(recovered >= 1, true);

  const after = await R().getTask(task.id);
  assert.equal(after?.status, "queued");
  assert.equal(after?.error.includes("重新入队"), true);
  const steps = await R().getSteps(task.id);
  assert.equal(steps[0].status, "pending", "执行中的步骤应回滚为 pending");
  const runRow = await query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [run.rows[0].id]);
  assert.equal(runRow.rows[0].status, "failed", "中断的 run 应标记失败");
});

test("retry 只重置 failed/skipped 步骤，已完成步骤保留", async () => {
  const user = await testUser("task-retry-scope");
  const task = await R().createTask({ userId: user.id, goal: "重试范围测试" });
  await R().createSteps(task.id, [
    { seq: 1, worker_type: "general", title: "已完成步骤", goal: "目标1" },
    { seq: 2, worker_type: "general", title: "失败步骤", goal: "目标2" },
    { seq: 3, worker_type: "general", title: "待执行步骤", goal: "目标3" }
  ]);
  await query("UPDATE task_steps SET status = 'completed' WHERE task_id = $1 AND seq = 1", [task.id]);
  await query("UPDATE task_steps SET status = 'failed' WHERE task_id = $1 AND seq = 2", [task.id]);
  await query("UPDATE tasks SET status = 'failed', error = '模拟失败' WHERE id = $1", [task.id]);

  await R().retryTask(task.id);
  const steps = await R().getSteps(task.id);
  const bySeq = Object.fromEntries(steps.map((s) => [s.seq, s.status]));
  assert.equal(bySeq[1], "completed", "已完成步骤保留");
  assert.equal(bySeq[2], "pending", "失败步骤重置");
  assert.equal(bySeq[3], "pending", "待执行步骤保持");
  assert.equal((await R().getTask(task.id))?.worker_id, "", "租约字段应清空");
});

test("产物并发版本化：同名并发注册 version 唯一递增", async () => {
  const user = await testUser("task-version-race");
  const task = await R().createTask({ userId: user.id, goal: "并发版本测试" });
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => A().registerTaskArtifact({
      taskId: task.id,
      userId: user.id,
      filename: `并发.md`,
      name: "并发",
      kind: "markdown",
      content: `内容 ${i}`
    }))
  );
  const versions = results.map((r) => r.version).sort((a, b) => a - b);
  assert.deepEqual(versions, [1, 2, 3, 4, 5]);
});

