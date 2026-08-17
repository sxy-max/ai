/**
 * Job State Machine（V1.3 WP2-3）：Durable Job + AgentSession 一等对象。
 * Task = 用户意图；Job = 一次真实执行（task 可有多 attempt）。
 * AgentSession = 连续 Agent 工作会话（可持久化运行实体）。
 *
 * Job 状态：queued → allocating → preparing → planning → running → waiting_tool →
 * validating → repairing → completed / failed / cancelled / interrupted / recovering
 */

import { query } from "../db/pool";

export type JobStatus =
  | "queued" | "allocating" | "preparing" | "planning" | "running"
  | "waiting_tool" | "validating" | "repairing"
  | "completed" | "failed" | "cancelled" | "interrupted" | "recovering";

export type JobCheckpoint = {
  stepSeq?: number;
  stepId?: string;
  /** Agent 循环阶段（plan/act/observe/validate/repair/finish）。 */
  loopPhase?: string;
  attempt?: number;
  /** 已消费的 agent 事件数（断点续跑游标）。 */
  eventCursor?: number;
  /** 工具结果摘要（断点后 Agent 可见）。 */
  lastToolResults?: Array<{ id: string; name: string; ok: boolean }>;
  /** workspace 版本（对应 snapshot）。 */
  workspaceVersion?: number;
  /** 产物候选（已注册但未最终确认）。 */
  artifactCandidates?: string[];
  /** 预算轨迹。 */
  budgetTier?: string;
  /** 重试状态。 */
  retryState?: { attempts: number; maxAttempts: number };
};

export type JobRow = {
  id: string;
  task_id: string;
  user_id: string;
  project_id: string | null;
  attempt: number;
  runtime: string | null;
  model: string | null;
  sandbox_id: string | null;
  workspace_id: string | null;
  status: JobStatus;
  current_step: string | null;
  checkpoint: JobCheckpoint;
  failure_code: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
  completed_at: string | null;
  created_at: string;
};

const JOB_COLUMNS = "id, task_id, user_id, project_id, attempt, runtime, model, sandbox_id, workspace_id, status, current_step, checkpoint, failure_code, lease_owner, lease_until, started_at, heartbeat_at, completed_at, created_at";

function rowToJob(row: Record<string, unknown>): JobRow {
  return {
    id: String(row.id),
    task_id: String(row.task_id),
    user_id: String(row.user_id),
    project_id: row.project_id ? String(row.project_id) : null,
    attempt: Number(row.attempt ?? 1),
    runtime: row.runtime ? String(row.runtime) : null,
    model: row.model ? String(row.model) : null,
    sandbox_id: row.sandbox_id ? String(row.sandbox_id) : null,
    workspace_id: row.workspace_id ? String(row.workspace_id) : null,
    status: row.status as JobStatus,
    current_step: row.current_step ? String(row.current_step) : null,
    checkpoint: (row.checkpoint as JobCheckpoint) || {},
    failure_code: row.failure_code ? String(row.failure_code) : null,
    lease_owner: row.lease_owner ? String(row.lease_owner) : null,
    lease_until: row.lease_until ? String(row.lease_until) : null,
    started_at: row.started_at ? String(row.started_at) : null,
    heartbeat_at: row.heartbeat_at ? String(row.heartbeat_at) : null,
    completed_at: row.completed_at ? String(row.completed_at) : null,
    created_at: String(row.created_at),
  };
}

/** 创建 Job（task 首次执行 attempt=1；重试递增）。 */
export async function createJob(input: {
  taskId: string;
  userId: string;
  projectId?: string | null;
  attempt?: number;
  runtime?: string;
  model?: string;
  workspaceId?: string;
}): Promise<JobRow> {
  const result = await query<Record<string, unknown>>(
    `INSERT INTO jobs (task_id, user_id, project_id, attempt, runtime, model, workspace_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
     RETURNING ${JOB_COLUMNS}`,
    [input.taskId, input.userId, input.projectId ?? null, input.attempt ?? 1, input.runtime ?? null, input.model ?? null, input.workspaceId ?? null]
  );
  return rowToJob(result.rows[0]);
}

/** 更新 Job 状态（幂等；completed/failed 后不再改 running）。 */
export async function updateJobStatus(jobId: string, status: JobStatus, extra: Partial<Pick<JobRow, "current_step" | "failure_code" | "sandbox_id" | "runtime" | "model">> = {}): Promise<void> {
  const sets: string[] = ["status = $2"];
  const values: unknown[] = [jobId, status];
  if (extra.current_step !== undefined) { sets.push(`current_step = $${values.length + 1}`); values.push(extra.current_step); }
  if (extra.failure_code !== undefined) { sets.push(`failure_code = $${values.length + 1}`); values.push(extra.failure_code); }
  if (extra.sandbox_id !== undefined) { sets.push(`sandbox_id = $${values.length + 1}`); values.push(extra.sandbox_id); }
  if (extra.runtime !== undefined) { sets.push(`runtime = $${values.length + 1}`); values.push(extra.runtime); }
  if (extra.model !== undefined) { sets.push(`model = $${values.length + 1}`); values.push(extra.model); }
  if (status === "running" || status === "allocating" || status === "preparing") {
    sets.push(`started_at = COALESCE(started_at, now())`);
  }
  if (status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted") {
    sets.push(`completed_at = now()`);
  }
  await query(`UPDATE jobs SET ${sets.join(", ")} WHERE id = $1`, values);
}

/** 写 checkpoint（每步/每阶段）。 */
export async function writeJobCheckpoint(jobId: string, checkpoint: JobCheckpoint, currentStep?: string): Promise<void> {
  await query(
    `UPDATE jobs SET checkpoint = $2, current_step = COALESCE($3, current_step), heartbeat_at = now() WHERE id = $1`,
    [jobId, JSON.stringify(checkpoint), currentStep ?? null]
  );
}

/** 心跳续租（lease_until = now + leaseMs）。 */
export async function heartbeatJob(jobId: string, leaseMs: number, owner: string): Promise<boolean> {
  const result = await query(
    `UPDATE jobs SET heartbeat_at = now(), lease_until = now() + make_interval(secs => $3)
     WHERE id = $1 AND lease_owner = $2 RETURNING id`,
    [jobId, owner, Math.ceil(leaseMs / 1000)]
  );
  return result.rows.length > 0;
}

/** 获取 Job。 */
export async function getJob(jobId: string): Promise<JobRow | null> {
  const result = await query<Record<string, unknown>>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1`, [jobId]);
  return result.rows[0] ? rowToJob(result.rows[0]) : null;
}

/** 任务最近 Job。 */
export async function latestJobForTask(taskId: string): Promise<JobRow | null> {
  const result = await query<Record<string, unknown>>(
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE task_id = $1 ORDER BY attempt DESC, created_at DESC LIMIT 1`, [taskId]
  );
  return result.rows[0] ? rowToJob(result.rows[0]) : null;
}

/**
 * 认领过期 Job（lease 超时且非终态；返回被认领 job 或 null）。
 * 2026-08-17 修复：只认领**每任务的最近 job**（attempt/created 最新）——
 * 历史 job（如 retry 前的旧 attempt）过期不得打断当前执行，也不得被重复认领。
 */
export async function claimExpiredJob(owner: string, leaseMs: number, statuses: JobStatus[]): Promise<JobRow | null> {
  const result = await query<Record<string, unknown>>(
    `UPDATE jobs SET lease_owner = $1, lease_until = now() + make_interval(secs => $3), status = 'recovering'
     WHERE id = (
       SELECT j.id FROM jobs j
       WHERE j.status = ANY($2::text[]) AND (j.lease_until IS NULL OR j.lease_until < now())
         AND j.id = (
           SELECT j2.id FROM jobs j2 WHERE j2.task_id = j.task_id
           ORDER BY j2.attempt DESC, j2.created_at DESC, j2.id DESC LIMIT 1
         )
       ORDER BY j.created_at LIMIT 1
     )
     RETURNING ${JOB_COLUMNS}`,
    [owner, statuses, Math.ceil(leaseMs / 1000)]
  );
  return result.rows[0] ? rowToJob(result.rows[0]) : null;
}

/** 任务所有 Job（历史）。 */
export async function listJobsForTask(taskId: string): Promise<JobRow[]> {
  const result = await query<Record<string, unknown>>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE task_id = $1 ORDER BY attempt`, [taskId]);
  return result.rows.map(rowToJob);
}

/* ---------- AgentSession（WP3） ---------- */

export type AgentSessionRow = {
  id: string;
  job_id: string;
  task_id: string;
  user_id: string;
  runtime: string;
  model: string | null;
  workspace_id: string | null;
  sandbox_id: string | null;
  state: string;
  current_step: string | null;
  tool_calls: number;
  context_version: number;
  created_at: string;
  closed_at: string | null;
};

export async function createAgentSession(input: {
  jobId: string | null;
  taskId: string;
  userId: string;
  runtime: string;
  model?: string;
  workspaceId?: string;
  sandboxId?: string;
}): Promise<AgentSessionRow> {
  const result = await query<Record<string, unknown>>(
    `INSERT INTO agent_sessions (job_id, task_id, user_id, runtime, model, workspace_id, sandbox_id, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'created')
     RETURNING id, job_id, task_id, user_id, runtime, model, workspace_id, sandbox_id, state, current_step, tool_calls, context_version, created_at, closed_at`,
    [input.jobId, input.taskId, input.userId, input.runtime, input.model ?? null, input.workspaceId ?? null, input.sandboxId ?? null]
  );
  return result.rows[0] as unknown as AgentSessionRow;
}

export async function updateAgentSession(sessionId: string, update: Partial<Pick<AgentSessionRow, "state" | "current_step" | "tool_calls" | "context_version" | "closed_at">>): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [sessionId];
  if (update.state !== undefined) { sets.push(`state = $${values.length + 1}`); values.push(update.state); }
  if (update.current_step !== undefined) { sets.push(`current_step = $${values.length + 1}`); values.push(update.current_step); }
  if (update.tool_calls !== undefined) { sets.push(`tool_calls = $${values.length + 1}`); values.push(update.tool_calls); }
  if (update.context_version !== undefined) { sets.push(`context_version = $${values.length + 1}`); values.push(update.context_version); }
  if (update.closed_at !== undefined) { sets.push(`closed_at = $${values.length + 1}`); values.push(update.closed_at); }
  if (!sets.length) return;
  sets.push("heartbeat_at = now()");
  await query(`UPDATE agent_sessions SET ${sets.join(", ")} WHERE id = $1`, values);
}

export async function getAgentSession(sessionId: string): Promise<AgentSessionRow | null> {
  const result = await query<Record<string, unknown>>(
    `SELECT id, job_id, task_id, user_id, runtime, model, workspace_id, sandbox_id, state, current_step, tool_calls, context_version, created_at, closed_at
     FROM agent_sessions WHERE id = $1`, [sessionId]
  );
  return result.rows[0] ? (result.rows[0] as unknown as AgentSessionRow) : null;
}
