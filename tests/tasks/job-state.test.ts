/** Job State Machine + AgentSession 测试（V1.3 WP2-3）。 */
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
// 测试隔离：删除模型 key
delete process.env.OPENCODE_GO_API_KEY; delete process.env.DEEPSEEK_API_KEY;
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../../lib/db/users";
import { query, closeDb } from "../../lib/db/pool";
import { closeRedis } from "../../lib/db/redis";
import { createTask } from "../../lib/tasks/repo";
import {
  createJob, updateJobStatus, writeJobCheckpoint, getJob, latestJobForTask,
  claimExpiredJob, listJobsForTask, createAgentSession, updateAgentSession, getAgentSession,
} from "../../lib/tasks/job";

let userId = "";

before(async () => {
  const user = await createUser({ email: `job-${Date.now()}@test.local`, displayName: "job", password: "password-123" });
  userId = user.id;
});

after(async () => {
  await closeDb();
  await closeRedis();
});

test("Job 生命周期：queued→running→completed，checkpoint 落盘", async () => {
  const task = await createTask({ userId, goal: "测试任务", title: "job-test" });
  const job = await createJob({ taskId: task.id, userId, projectId: null, runtime: "claude-code", workspaceId: "tasks/x" });
  assert.equal(job.status, "queued");
  assert.equal(job.attempt, 1);
  assert.equal(job.runtime, "claude-code");

  await updateJobStatus(job.id, "running", { current_step: "分析输入" });
  await writeJobCheckpoint(job.id, { stepSeq: 1, stepId: "s1", loopPhase: "act", attempt: 1, budgetTier: "tool_loop" }, "分析输入");

  const mid = await getJob(job.id);
  assert.equal(mid?.status, "running");
  assert.equal(mid?.current_step, "分析输入");
  assert.equal(mid?.checkpoint.stepSeq, 1);
  assert.equal(mid?.checkpoint.budgetTier, "tool_loop");
  assert.ok(mid?.started_at, "running 应记录 started_at");

  await updateJobStatus(job.id, "completed");
  const done = await getJob(job.id);
  assert.equal(done?.status, "completed");
  assert.ok(done?.completed_at, "completed 应记录 completed_at");
});

test("Job 失败：failure_code 分层记录", async () => {
  const task = await createTask({ userId, goal: "失败任务", title: "job-fail" });
  const job = await createJob({ taskId: task.id, userId });
  await updateJobStatus(job.id, "failed", { failure_code: "RUNTIME_TIMEOUT" });
  const failed = await getJob(job.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.failure_code, "RUNTIME_TIMEOUT");
});

test("任务多 Job 历史（attempt 序列）", async () => {
  const task = await createTask({ userId, goal: "多尝试", title: "job-attempts" });
  await createJob({ taskId: task.id, userId, attempt: 1 });
  await createJob({ taskId: task.id, userId, attempt: 2 });
  const jobs = await listJobsForTask(task.id);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((j) => j.attempt), [1, 2]);
  const latest = await latestJobForTask(task.id);
  assert.equal(latest?.attempt, 2);
});

test("过期 Job 认领：lease 超时且非终态 → 其他 worker 接管（recovering）", async () => {
  const task = await createTask({ userId, goal: "租约", title: "job-lease" });
  const job = await createJob({ taskId: task.id, userId });
  // 模拟旧 worker 死亡：lease 已过期、状态 running
  await query("UPDATE jobs SET lease_owner = 'dead-worker', lease_until = now() - interval '1 minute', status = 'running' WHERE id = $1", [job.id]);

  const claimed = await claimExpiredJob("worker-2", 90_000, ["running", "planning", "waiting_tool", "repairing", "recovering"]);
  assert.ok(claimed, "应能认领过期 job");
  assert.equal(claimed?.lease_owner, "worker-2");
  assert.equal(claimed?.status, "recovering");

  // 未过期的不被认领
  const task2 = await createTask({ userId, goal: "租约2", title: "job-lease2" });
  const job2 = await createJob({ taskId: task2.id, userId });
  await query("UPDATE jobs SET lease_owner = 'alive', lease_until = now() + interval '1 minute', status = 'running' WHERE id = $1", [job2.id]);
  const notClaimed = await claimExpiredJob("worker-2", 90_000, ["running"]);
  assert.ok(!notClaimed || notClaimed.task_id !== task2.id, "有效租约的本任务 job 不应被认领");
});


test("V1.3 WP12：worker 死亡后 Job 租约恢复（任务重新入队）", async () => {
  const task = await createTask({ userId, goal: "崩溃恢复", title: "job-recover" });
  const job = await createJob({ taskId: task.id, userId, runtime: "claude-code" });
  // 模拟 worker 崩溃：任务 running + lease 过期 + job running + lease 过期
  await query("UPDATE tasks SET status = 'running', lease_expires = now() - interval '1 minute' WHERE id = $1", [task.id]);
  await query("UPDATE jobs SET status = 'running', lease_owner = 'dead', lease_until = now() - interval '1 minute' WHERE id = $1", [job.id]);

  const { recoverOrphanedTasks } = await import("../../lib/tasks/worker");
  const recovered = await recoverOrphanedTasks();
  assert.ok(recovered >= 2, "任务与 job 都应被回收");

  const taskAfter = await query<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [task.id]);
  assert.equal(taskAfter.rows[0].status, "queued", "任务应重新入队");
  const jobAfter = await getJob(job.id);
  assert.equal(jobAfter?.status, "recovering", "job 应标记 recovering");
  assert.equal(jobAfter?.lease_owner, "worker-" + process.pid, "job 应由新 worker 认领");
});
test("AgentSession：创建→工具计数→完成关闭", async () => {
  const task = await createTask({ userId, goal: "会话", title: "session-test" });
  const job = await createJob({ taskId: task.id, userId, runtime: "claude-code" });
  const session = await createAgentSession({ jobId: job.id, taskId: task.id, userId, runtime: "claude-code", workspaceId: "tasks/x" });
  assert.equal(session.state, "created");

  await updateAgentSession(session.id, { state: "running", tool_calls: 3 });
  const mid = await getAgentSession(session.id);
  assert.equal(mid?.state, "running");
  assert.equal(mid?.tool_calls, 3);

  await updateAgentSession(session.id, { state: "completed", closed_at: new Date().toISOString() });
  const done = await getAgentSession(session.id);
  assert.equal(done?.state, "completed");
  assert.ok(done?.closed_at, "完成应记录 closed_at");
});
