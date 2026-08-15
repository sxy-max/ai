/**
 * TaskExecutionMetrics（V1.2 WP20）：任务执行指标持久化。
 * 回答"为什么这个任务慢"：队列/规划/运行/验证时间、重试、工具调用、token、产物、runtime、model、success。
 * 不引入 Prometheus 等重基础设施——PG 表 + upsert。
 */

import { query } from "../db/pool";

export type TaskMetricsInput = {
  taskId: string;
  userId: string;
  /** 任务开始执行（worker 领取）时间。 */
  startedAt: number;
  /** 任务结束时间。 */
  finishedAt: number;
  retryCount: number;
  toolCalls: number;
  reasoningTokens?: number | null;
  outputTokens?: number | null;
  artifactCount: number;
  runtime?: string | null;
  model?: string | null;
  success: boolean;
  failureCode?: string | null;
};

/** 写一条任务指标（upsert；重复执行幂等覆盖）。 */
export async function recordTaskMetrics(input: TaskMetricsInput): Promise<void> {
  const queueMs = Math.max(input.finishedAt - input.startedAt, 0);
  try {
    await query(
      `INSERT INTO task_metrics (task_id, user_id, queue_ms, planning_ms, runtime_ms, validation_ms, retry_count, tool_calls, reasoning_tokens, output_tokens, artifact_count, runtime, model, success, failure_code)
       VALUES ($1, $2, $3, NULL, NULL, NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (task_id) DO UPDATE SET
         queue_ms = EXCLUDED.queue_ms,
         retry_count = EXCLUDED.retry_count,
         tool_calls = EXCLUDED.tool_calls,
         reasoning_tokens = EXCLUDED.reasoning_tokens,
         output_tokens = EXCLUDED.output_tokens,
         artifact_count = EXCLUDED.artifact_count,
         runtime = EXCLUDED.runtime,
         model = EXCLUDED.model,
         success = EXCLUDED.success,
         failure_code = EXCLUDED.failure_code,
         created_at = now()`,
      [
        input.taskId,
        input.userId,
        queueMs,
        input.retryCount,
        input.toolCalls,
        input.reasoningTokens ?? null,
        input.outputTokens ?? null,
        input.artifactCount,
        input.runtime ?? null,
        input.model ?? null,
        input.success,
        input.failureCode ?? null,
      ]
    );
  } catch {
    // metrics 失败不影响任务（可观测性降级）
  }
}

export type TaskMetricsRow = {
  task_id: string;
  queue_ms: number | null;
  retry_count: number;
  tool_calls: number;
  artifact_count: number;
  runtime: string | null;
  model: string | null;
  success: boolean;
  failure_code: string | null;
  created_at: string;
};

/** 查询单任务指标。 */
export async function getTaskMetrics(taskId: string): Promise<TaskMetricsRow | null> {
  try {
    const result = await query<TaskMetricsRow>("SELECT * FROM task_metrics WHERE task_id = $1", [taskId]);
    return result.rows[0] || null;
  } catch {
    return null;
  }
}
