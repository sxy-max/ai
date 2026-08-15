/** Task 数据访问层：PG 是任务状态源，事件持久化到 task_events（SSE 游标读取）。 */

import { query, withTransaction } from "../db/pool";
import { publishTaskEvent } from "../db/redis";
import { assertTransition, TERMINAL_STATUSES } from "./state";
import type { AgentRunRow, NewTaskInput, PlanStep, TaskEventRow, TaskEventType, TaskRow, TaskStepRow } from "./types";

const TASK_COLUMNS = "id, user_id, project_id, parent_task_id, parent_artifact_id, workspace_parent_version, title, goal, description, status, type, priority, current_stage, progress, plan, planner_run_id, result_summary, error, worker_id, lease_expires, created_at, started_at, updated_at, completed_at";

function rowToTask(row: Record<string, unknown>): TaskRow {
  return {
    ...(row as unknown as TaskRow),
    plan: (row.plan ?? []) as PlanStep[]
  };
}

// ============ 创建 / 查询 ============

export async function createTask(input: NewTaskInput): Promise<TaskRow> {
  const title = input.title?.trim() || defaultTitle(input.goal);
  const result = await query<TaskRow>(
    `INSERT INTO tasks (user_id, project_id, parent_task_id, title, goal, type, priority, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
     RETURNING ${TASK_COLUMNS}`,
    [input.userId, input.projectId ?? null, input.parentTaskId ?? null, title, input.goal.trim(), input.type ?? "artifact", input.priority ?? "normal"]
  );
  const task = rowToTask(result.rows[0]);
  await emitTaskEvent(task.id, "task.created", { title: task.title, goal: task.goal });
  if (input.fileIds?.length) await bindTaskFiles(task.id, input.fileIds);
  return task;
}

export async function getTask(id: string): Promise<TaskRow | null> {
  const result = await query<Record<string, unknown>>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1`, [id]);
  return result.rows[0] ? rowToTask(result.rows[0]) : null;
}

export async function listTasks(userId: string, limit = 50, offset = 0): Promise<TaskRow[]> {
  const result = await query<Record<string, unknown>>(
    `SELECT ${TASK_COLUMNS},
       (SELECT count(*)::int FROM artifacts a WHERE a.task_id = tasks.id) AS artifact_count,
       (SELECT count(*)::int FROM task_steps s WHERE s.task_id = tasks.id AND s.status = 'completed') AS steps_done,
       (SELECT count(*)::int FROM task_steps s WHERE s.task_id = tasks.id) AS steps_total
     FROM tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return result.rows.map(rowToTask);
}

export async function updateTaskStatus(id: string, to: TaskRow["status"], extra?: { error?: string; resultSummary?: string; progress?: number }) {
  await withTransaction(async (client) => {
    const current = await client.query<{ status: TaskRow["status"] }>("SELECT status FROM tasks WHERE id = $1 FOR UPDATE", [id]);
    if (!current.rows[0]) throw new Error("TASK_NOT_FOUND");
    const from = current.rows[0].status;
    assertTransition(from, to);
    const fields: string[] = ["status = $2", "updated_at = now()"];
    const params: unknown[] = [id, to];
    if (to === "completed" || to === "failed" || to === "cancelled") fields.push("completed_at = now()");
    if (to === "failed") { fields.push("error = $3"); params.push(extra?.error ?? ""); }
    if (to === "queued") { fields.push("error = ''", "completed_at = NULL"); }
    if (extra?.resultSummary != null) { fields.push("result_summary = $3"); params.push(extra.resultSummary); }
    if (extra?.progress != null) { fields.push("progress = $3"); params.push(extra.progress); }
    await client.query(`UPDATE tasks SET ${fields.join(", ")} WHERE id = $1`, params);
  });
}

export async function updateTaskStage(id: string, stage: string, progress: number) {
  await query("UPDATE tasks SET current_stage = $2, progress = $3, updated_at = now() WHERE id = $1", [id, stage, progress]);
}

// ============ 步骤 ============

export async function createSteps(taskId: string, steps: PlanStep[]): Promise<TaskStepRow[]> {
  return withTransaction(async (client) => {
    for (const step of steps) {
      await client.query(
        `INSERT INTO task_steps (task_id, seq, worker_type, phase, title, goal, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         ON CONFLICT (task_id, seq) DO UPDATE SET worker_type = EXCLUDED.worker_type, phase = EXCLUDED.phase, title = EXCLUDED.title, goal = EXCLUDED.goal, status = 'pending', error = ''`,
        [taskId, step.seq, step.worker_type, step.phase || "", step.title, step.goal]
      );
    }
    const result = await client.query<Record<string, unknown>>(
      "SELECT * FROM task_steps WHERE task_id = $1 ORDER BY seq", [taskId]
    );
    return result.rows as unknown as TaskStepRow[];
  });
}

export async function getSteps(taskId: string): Promise<TaskStepRow[]> {
  const result = await query<Record<string, unknown>>("SELECT * FROM task_steps WHERE task_id = $1 ORDER BY seq", [taskId]);
  return result.rows as unknown as TaskStepRow[];
}

export async function getStep(stepId: string): Promise<TaskStepRow | null> {
  const result = await query<Record<string, unknown>>("SELECT * FROM task_steps WHERE id = $1", [stepId]);
  return result.rows[0] ? (result.rows[0] as unknown as TaskStepRow) : null;
}

export async function updateStepStatus(
  stepId: string,
  status: TaskStepRow["status"],
  extra?: { detail?: Record<string, unknown>; error?: string }
) {
  await withTransaction(async (client) => {
    const fields: string[] = ["status = $2", "updated_at = now()"];
    const params: unknown[] = [stepId, status];
    if (status === "running") fields.push("started_at = COALESCE(started_at, now())");
    if (status === "completed") { fields.push("completed_at = now()"); fields.push("error = ''"); }
    if (status === "failed") { fields.push("error = $3"); params.push(extra?.error ?? ""); }
    if (extra?.detail) { fields.push(`detail = detail || $3::jsonb`); params.push(JSON.stringify(extra.detail)); }
    await client.query(`UPDATE task_steps SET ${fields.join(", ")} WHERE id = $1`, params);
  });
}

// ============ Agent Run ============

export async function createAgentRun(input: { taskId: string; stepId: string; workerType: AgentRunRow["worker_type"] }): Promise<AgentRunRow> {
  const result = await query<AgentRunRow>(
    `INSERT INTO agent_runs (task_id, step_id, worker_type, status) VALUES ($1, $2, $3, 'running')
     RETURNING id, task_id, step_id, worker_type, agent_id, status, summary, started_at, completed_at, created_at`,
    [input.taskId, input.stepId, input.workerType]
  );
  return result.rows[0];
}

export async function completeAgentRun(runId: string, status: AgentRunRow["status"], summary: string) {
  await query(
    `UPDATE agent_runs SET status = $2, summary = $3, completed_at = now() WHERE id = $1`,
    [runId, status, summary]
  );
}

// ============ 事件（PRD §64）============

export async function emitTaskEvent(taskId: string, type: TaskEventType, payload: Record<string, unknown> = {}) {
  await query(
    "INSERT INTO task_events (task_id, type, payload) VALUES ($1, $2, $3::jsonb)",
    [taskId, type, JSON.stringify(payload)]
  ).catch((err) => console.error("[tasks] emit event failed:", err.message));
  publishTaskEvent(taskId, type, payload);
}

export async function listTaskEvents(taskId: string, afterId?: string, limit = 500): Promise<TaskEventRow[]> {
  const params: unknown[] = [taskId, limit];
  let after = "";
  if (afterId) { after = "AND id > $3"; params.push(afterId); }
  const result = await query<Record<string, unknown>>(
    `SELECT id::text AS id, task_id, type, payload, created_at FROM task_events
     WHERE task_id = $1 ${after} ORDER BY id ASC LIMIT $2`,
    params
  );
  return result.rows as unknown as TaskEventRow[];
}

// ============ 文件绑定 ============

export async function bindTaskFiles(taskId: string, fileIds: string[]) {
  await query("UPDATE files SET task_id = $1 WHERE id = ANY($2::uuid[]) AND task_id IS NULL", [taskId, fileIds]);
}

export async function taskFiles(taskId: string) {
  const result = await query<Record<string, unknown>>(
    "SELECT id, filename, mime, size, storage_key, metadata FROM files WHERE task_id = $1 ORDER BY created_at",
    [taskId]
  );
  return result.rows as unknown as Array<Record<string, unknown>>;
}

// ============ 操作：暂停/恢复/取消/重试 ============

export async function pauseTask(taskId: string) {
  await updateTaskStatus(taskId, "paused");
  await emitTaskEvent(taskId, "task.paused", {});
}

export async function resumeTask(taskId: string) {
  await updateTaskStatus(taskId, "running");
  await emitTaskEvent(taskId, "task.resumed", {});
}

export async function cancelTask(taskId: string) {
  const task = await getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (TERMINAL_STATUSES.has(task.status)) throw new Error("TASK_ALREADY_FINISHED");
  await updateTaskStatus(taskId, "cancelled");
  // 挂起的步骤标记为 skipped；执行中的步骤由 worker 在检查点自然收尾（避免覆盖竞态）
  await query("UPDATE task_steps SET status = 'skipped' WHERE task_id = $1 AND status IN ('pending', 'blocked')", [taskId]);
  // 执行中的 Agent Run 收尾（步骤本身可能已完成后被 worker 置 completed，属正常时序）
  await query(
    "UPDATE agent_runs SET status = 'cancelled', completed_at = COALESCE(completed_at, now()) WHERE task_id = $1 AND status = 'running'",
    [taskId]
  );
  await emitTaskEvent(taskId, "task.cancelled", {});
}

/** 继续任务（多轮语义）：追加新要求 → 重新规划执行（复用同一 workspace，产物版本化）。 */
export async function continueTask(taskId: string, newGoal: string) {
  const task = await getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled") throw new Error("TASK_NOT_CONTINUABLE");
  const trimmed = String(newGoal || "").trim();
  if (!trimmed) throw new Error("GOAL_REQUIRED");
  // V1.3 WP20：lineage——记录上轮最新产物 id 与 workspace manifest 版本（二轮继承上轮 workspace）
  const latestArtifact = await query<{ id: string }>(
    "SELECT id FROM artifacts WHERE task_id = $1 AND status = 'ready' ORDER BY created_at DESC LIMIT 1", [taskId]
  );
  const parentArtifactId = latestArtifact.rows[0]?.id || null;
  let workspaceVersion: number | null = null;
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const manifestPath = path.join(process.env.WORKSPACES_ROOT || "/data/workspaces", "tasks", taskId, ".go-ai", "workspace-manifest.json");
    if (fs.existsSync(manifestPath)) {
      workspaceVersion = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version ?? null;
    }
  } catch {}
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE tasks SET status = 'queued', goal = $2, plan = '[]'::jsonb, result_summary = '', error = '',
       progress = 0, current_stage = '', worker_id = '', lease_expires = NULL, completed_at = NULL, updated_at = now(),
       parent_task_id = CASE WHEN parent_task_id IS NULL THEN id ELSE parent_task_id END,
       parent_artifact_id = $3,
       workspace_parent_version = $4
       WHERE id = $1`,
      [taskId, `${task.goal}

（追加要求）${trimmed}`, parentArtifactId, workspaceVersion]
    );
    // 清空旧步骤（重新规划，产物保留版本化）
    await client.query("DELETE FROM task_steps WHERE task_id = $1", [taskId]);
  });
  await emitTaskEvent(taskId, "task.continued", { newGoal: trimmed, parentArtifactId, workspaceVersion });
}

export async function retryTask(taskId: string) {
  const task = await getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.status !== "failed" && task.status !== "cancelled") throw new Error("TASK_NOT_RETRYABLE");
  await withTransaction(async (client) => {
    await client.query(
      "UPDATE tasks SET status = 'queued', error = '', result_summary = '', progress = 0, current_stage = '', worker_id = '', lease_expires = NULL, completed_at = NULL, updated_at = now() WHERE id = $1",
      [taskId]
    );
    // 只重置失败/跳过的步骤；已完成的保留（跳过逻辑在 worker 里），未开始的保持 pending
    await client.query(
      "UPDATE task_steps SET status = 'pending', error = '', started_at = NULL, completed_at = NULL WHERE task_id = $1 AND status IN ('failed', 'skipped')",
      [taskId]
    );
  });
  await emitTaskEvent(taskId, "task.retried", {});
}

// ============ 内部工具 ============

function defaultTitle(goal: string): string {
  const firstLine = goal.split("\n").find((line) => line.trim()) || goal;
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}
