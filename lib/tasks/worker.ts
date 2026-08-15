/**
 * Task Worker 主循环（PRD §63）：轮询 PG 领取 queued 任务 → 规划 → 逐步执行。
 * 页面/服务重启不影响：任务状态全部在 PG，Worker 领取后从断点继续。
 */

import { query } from "../db/pool";
import { buildExecutionPlan } from "./executionPlan";
import { generatePlan } from "../leader/planner";
import { executeStep } from "./executor";
import { notifyTaskFinished } from "./notify";
import { WorkspaceManager } from "../workspace/service";
import { requirementsFromPlan } from "../policy/capabilities";
import { planExecutionPolicy, type ExecutionPolicy } from "../policy/executionPolicy";

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || "/data/workspaces";
import {
  createAgentRun,
  completeAgentRun,
  createSteps,
  emitTaskEvent,
  getSteps,
  getTask,
  taskFiles,
  updateStepStatus,
  updateTaskStage,
  updateTaskStatus
} from "./repo";
import type { TaskEventType, TaskRow } from "./types";
import { listProjectMemory, listUserMemory } from "./memory";
import { listTaskArtifacts } from "./artifacts";
import { validateTaskCompletion } from "./completion";
import { listEnabledSkillsText } from "./skills";
import { recordTaskMetrics } from "./metrics";
import { createJob, heartbeatJob, updateJobStatus, writeJobCheckpoint, claimExpiredJob, type JobCheckpoint } from "./job";

export type WorkerOptions = {
  pollMs?: number;
  signal?: AbortSignal;
};

const LEASE_SECONDS = 90;
const LEASE_RENEW_INTERVAL_MS = 30_000;
const WORKSPACE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 每 6 小时
const WORKSPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;          // workspace TTL 7 天

/** 可用运行时（V1.2 WP7）：deterministic 恒可用；claude-code 由 AGENT_URL 判定；agentscope 由 AGENTSCOPE_URL 判定。 */
export function runtimeAvailability(): Array<"deterministic" | "claude-code" | "agentscope"> {
  const available: Array<"deterministic" | "claude-code" | "agentscope"> = ["deterministic"];
  if (process.env.AGENT_URL?.trim() || process.env.AGENTSCOPE_URL?.trim()) available.push("claude-code");
  if (process.env.AGENTSCOPE_URL?.trim()) available.push("agentscope");
  return available;
}

/** 启动任务 Worker 循环（阻塞；abort 时退出）。 */
export async function runTaskWorkerLoop(options: WorkerOptions = {}): Promise<void> {
  const signal = options.signal || new AbortController().signal;
  const pollMs = options.pollMs ?? 1500;
  let consecutiveErrors = 0;
  let lastWorkspaceCleanup = 0;

  console.log("[task-worker] 启动（poll", pollMs, "ms）");
  while (!signal.aborted) {
    try {
      await recoverOrphanedTasks();
      // 定期清理过期 workspace（避免磁盘累积，WP12）
      if (Date.now() - lastWorkspaceCleanup > WORKSPACE_CLEANUP_INTERVAL_MS) {
        lastWorkspaceCleanup = Date.now();
        try {
          // WP17：执行中的任务 workspace 排除；failed 任务短 TTL（3 天），其余 7 天
          const active = await query<{ id: string }>(
            "SELECT id FROM tasks WHERE status IN ('queued','planning','running','preparing_workspace','validating','retrying','waiting_user','paused')"
          );
          const activeIds = new Set(active.rows.map((r) => r.id));
          const failedShort = await query<{ id: string }>(
            "SELECT id FROM tasks WHERE status = 'failed' AND completed_at < now() - interval '3 days'"
          );
          const shortTtlIds = new Set(failedShort.rows.map((r) => r.id));
          let removed = WorkspaceManager.cleanupExpired(WORKSPACES_ROOT, WORKSPACE_TTL_MS, Date.now(), activeIds);
          if (shortTtlIds.size > 0) {
            removed += WorkspaceManager.cleanupExpired(WORKSPACES_ROOT, 3 * 24 * 60 * 60 * 1000, Date.now(), activeIds);
          }
          if (removed > 0) console.log(`[task-worker] 清理 ${removed} 个过期 workspace`);
        } catch (error) {
          console.error("[task-worker] workspace 清理失败:", error instanceof Error ? error.message : error);
        }
      }
      const taskId = await claimNextTask();
      if (taskId) {
        consecutiveErrors = 0;
        await runTaskToEnd(taskId, signal);
      } else {
        consecutiveErrors = 0;
        await sleep(pollMs, signal);
      }
    } catch (error) {
      consecutiveErrors += 1;
      console.error("[task-worker] loop error:", error instanceof Error ? error.message : error);
      await sleep(Math.min(1000 * 2 ** Math.min(consecutiveErrors, 4), 30_000), signal);
    }
  }
  console.log("[task-worker] 已停止");
}

/** 孤儿回收（崩溃恢复，PRD §44「重启/断线后继续任务」）：租约过期的执行态任务重新入队。 */
export async function recoverOrphanedTasks(): Promise<number> {
  const result = await query(
    `UPDATE tasks SET status = 'queued', worker_id = '', lease_expires = NULL,
            error = '任务在上一轮执行中被中断，已重新入队', updated_at = now()
     WHERE status IN ('planning', 'running', 'preparing_workspace', 'validating', 'retrying')
       AND lease_expires IS NOT NULL AND lease_expires < now()
     RETURNING id`
  );
  for (const row of result.rows as Array<{ id: string }>) {
    // 执行中的步骤回滚为 pending，跑了一半的 run 标记失败
    await query("UPDATE task_steps SET status = 'pending', error = '' WHERE task_id = $1 AND status = 'running'", [row.id]);
    await query(
      "UPDATE agent_runs SET status = 'failed', summary = 'worker 中断', completed_at = now() WHERE task_id = $1 AND status = 'running'",
      [row.id]
    );
    console.log(`[task-worker] 回收孤儿任务 ${row.id}`);
  }
  // V1.3 WP12：Job 级租约恢复（worker 死亡后其他 worker 认领；对应任务重新入队）——循环处理全部过期 job
  let jobRecovered = 0;
  while (true) {
    const claim = await claimExpiredJob(`worker-${process.pid}`, LEASE_SECONDS * 1000, ["running", "planning", "waiting_tool", "repairing", "recovering"]);
    if (!claim) break;
    await query(
      "UPDATE tasks SET status = 'queued', worker_id = '', lease_expires = NULL, updated_at = now() WHERE id = $1 AND status IN ('planning','running','preparing_workspace','validating','retrying','queued')",
      [claim.task_id]
    );
    console.log(`[task-worker] Job ${claim.id}（任务 ${claim.task_id}）租约过期，重新入队`);
    jobRecovered++;
  }
  return result.rows.length + jobRecovered;
}

async function claimNextTask(): Promise<string | null> {
  // FOR UPDATE SKIP LOCKED：多 Worker 不会重复领取；优先高优先级任务；领取即写租约
  const result = await query<{ id: string }>(
    `UPDATE tasks
     SET status = 'planning', started_at = COALESCE(started_at, now()), updated_at = now(),
         worker_id = $1, lease_expires = now() + make_interval(secs => $2)
     WHERE id = (
       SELECT id FROM tasks WHERE status = 'queued'
       ORDER BY (priority = 'high') DESC, created_at ASC
       LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
    [String(process.pid || "worker"), LEASE_SECONDS]
  );
  return result.rows[0]?.id ?? null;
}

/** 跑完一个任务（规划 → 步骤执行 → 收尾）。 */
export async function runTaskToEnd(taskId: string, signal: AbortSignal): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;
  // V1.2 WP20：执行指标起始时间
  const startedAt = Date.now();
  // V1.2 WP3：执行策略（执行阶段赋值；catch 分支也可用）
  let policy: ExecutionPolicy = planExecutionPolicy({
    requirements: { requiredCapabilities: [], reasoningNeeded: "auto", visionNeeded: false, workspaceNeeded: false, toolsNeeded: false, artifactKinds: [], taskType: "chat" },
    availableRuntimes: runtimeAvailability(),
  });
  // V1.3 WP2：Durable Job（执行阶段创建；catch 分支也可用）
  let job: Awaited<ReturnType<typeof createJob>> | null = null;

  console.log(`[task-worker] 处理任务 ${taskId}（${task.title}）`);
  await emitTaskEvent(task.id, "task.started", { title: task.title });

  // V1.3 WP19：per-task abort（Cancel 时中断正在执行的 Agent/Sandbox，而非等步骤自然结束）
  const taskAbort = new AbortController();
  const runSignal = AbortSignal.any([signal, taskAbort.signal]);

  // 租约心跳：执行期间定期续期，崩溃后由其他 worker 按 lease_expires 回收
  const heartbeat = setInterval(() => {
    void query("UPDATE tasks SET lease_expires = now() + make_interval(secs => $2) WHERE id = $1 AND status IN ('planning','running','preparing_workspace','validating','retrying')", [taskId, LEASE_SECONDS]).catch(() => {});
    // V1.3 WP2：Job 级心跳续租
    if (job) void heartbeatJob(job.id, LEASE_SECONDS * 1000, `worker-${process.pid}`).catch(() => {});
    // V1.3 WP19：Cancel 检测——任务被取消则中断当前执行
    void query("SELECT status FROM tasks WHERE id = $1", [taskId])
      .then((r) => {
        if (r.rows[0]?.status === "cancelled" && !taskAbort.signal.aborted) {
          console.log(`[task-worker] 任务 ${taskId} 已取消，中断当前执行`);
          taskAbort.abort();
        }
      })
      .catch(() => {});
  }, LEASE_RENEW_INTERVAL_MS);
  heartbeat.unref?.();

  try {
    // 直接调用（测试/API 触发）时任务可能还在 queued：先执行领取迁移（等价 worker 循环的 claim）
    if (task.status === "queued") {
      await updateTaskStatus(task.id, "planning");
    }
    // ===== 规划阶段（已有 plan 的任务（retry）跳过） =====
    if (!task.plan?.length) {
      const context = await buildPlanContext(task);
      const plan = await generatePlan(task, context);
      await createSteps(task.id, plan);
      await query("UPDATE tasks SET plan = $2::jsonb WHERE id = $1", [task.id, JSON.stringify(plan)]);
      const executionPlan = buildExecutionPlan(task, context.files);
      await emitTaskEvent(task.id, "plan.created", { steps: plan.map((step) => ({ ...step })), executionPlan });
      console.log(`[task-worker]   plan: ${plan.map((step) => `${step.seq}.${step.worker_type}(${step.title})`).join(" → ")}`);
    } else {
      console.log(`[task-worker]   复用已有 plan（${task.plan.length} 步）`);
    }
    await updateTaskStatus(task.id, "running");

    // ===== 执行阶段 =====
    const steps = await getSteps(task.id);
    const context = await buildPlanContext(task);
    // V1.2 WP3/WP7：生成统一执行策略（runtime/模型角色/预算/工具）；dev 步骤据此选 runtime
    const executionPlan = buildExecutionPlan(task, context.files);
    // V1.3 WP22-23：availableModels 来自 ProviderHealth（probe 结果；不可用模型被排除）
    let availableModels: string[] | undefined;
    try {
      const { providerHealthRegistry } = await import("../policy/providerHealth");
      const { readProbeResults, applyProbeCacheToRegistry } = await import("../policy/providerProbe");
      applyProbeCacheToRegistry(await readProbeResults());
      availableModels = providerHealthRegistry.availableModels(
        (process.env.FEATURED_MODELS || "deepseek-v4-pro,deepseek-v4-flash,kimi-k3,qwen3.8-max,glm-5.2,minimax-m3,gpt-5.6-luna,grok-4.5")
          .split(",").map((m) => m.trim()).filter(Boolean)
      );
    } catch {}
    policy = planExecutionPolicy({
      requirements: requirementsFromPlan(executionPlan),
      availableRuntimes: runtimeAvailability(),
      availableModels,
    });
    // V1.3 WP2：创建 Durable Job（Task=意图，Job=执行；重试时 attempt 递增）
    job = await createJob({
      taskId: task.id,
      userId: task.user_id,
      projectId: task.project_id,
      attempt: 1,
      runtime: policy.runtime.runtime,
      workspaceId: `tasks/${task.id}`,
    });
    const jobOwner = `worker-${process.pid}`;
    await query("UPDATE jobs SET lease_owner = $2, lease_until = now() + make_interval(secs => $3) WHERE id = $1", [job.id, jobOwner, LEASE_SECONDS]);
    let summaryParts: string[] = [];

    for (const step of steps) {
      // 暂停/取消检查点
      const control = await checkPoint(taskId, runSignal);
      if (control === "cancelled") {
        await emitTaskEvent(taskId, "task.cancelled", {});
        return;
      }

      if (step.status === "completed") {
        if (step.detail?.summary) summaryParts.push(String(step.detail.summary));
        continue; // retry 后已完成的步骤
      }

      await updateStepStatus(step.id, "running");
      await updateTaskStage(task.id, step.title, progressFor(taskId, steps.length, step.seq));
      await emitTaskEvent(taskId, "step.started", { seq: step.seq, title: step.title, worker: step.worker_type });
      // V1.3 WP2：Job 状态 + checkpoint（断点续跑）
      await updateJobStatus(job!.id, "running", { current_step: step.title });
      await writeJobCheckpoint(job!.id, { stepSeq: step.seq, stepId: step.id, loopPhase: "act", attempt: job!.attempt });

      if (step.worker_type === "dev" && task.status === "running") {
        await updateTaskStatus(task.id, "preparing_workspace");
        await updateTaskStatus(task.id, "running");
      }
      const run = await createAgentRun({ taskId: task.id, stepId: step.id, workerType: step.worker_type });
      await emitTaskEvent(taskId, "agent.started", { runId: run.id, worker: step.worker_type, title: step.title });

      try {
        const { summary } = await executeStep({
          task: { id: task.id, title: task.title, goal: task.goal, project_id: task.project_id, user_id: task.user_id },
          step: { id: step.id, seq: step.seq, worker_type: step.worker_type, title: step.title, goal: step.goal },
          userId: task.user_id,
          projectId: task.project_id,
          files: await taskFiles(task.id).then((files) =>
            files.map((file) => ({
              id: String(file.id),
              filename: String(file.filename),
              mime: String(file.mime || ""),
              size: Number(file.size || 0),
              storageKey: String(file.storage_key || "")
            }))
          ),
          projectContext: context.projectContext,
          userMemory: context.userMemory,
          skills: context.skills,
          policy,
          signal: runSignal,
          emit: (type: TaskEventType, payload: Record<string, unknown> = {}) => emitTaskEvent(task.id, type, payload)
        });
        // F3 守卫：执行期间任务被取消/失败/重试 → 丢弃本步骤结果（避免旧执行污染新 run）
        const postRun = await getTask(task.id);
        if (postRun && (postRun.status === "cancelled" || postRun.status === "failed" || postRun.status === "queued")) {
          await completeAgentRun(run.id, "cancelled", "任务已取消，步骤结果丢弃");
          await emitTaskEvent(taskId, "agent.completed", { runId: run.id, worker: step.worker_type, summary: "已取消" });
          return;
        }
        await completeAgentRun(run.id, "completed", summary);
        await updateStepStatus(step.id, "completed", { detail: { summary } });
        await emitTaskEvent(taskId, "agent.completed", { runId: run.id, worker: step.worker_type, summary });
        await emitTaskEvent(taskId, "step.completed", { seq: step.seq, title: step.title, summary });
        summaryParts.push(summary);
        // V1.3 WP2：步骤级 checkpoint（崩溃后从已完成步骤继续）
        await writeJobCheckpoint(job!.id, { stepSeq: step.seq, stepId: step.id, loopPhase: "finish", attempt: job!.attempt });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await completeAgentRun(run.id, "failed", message);
        await updateStepStatus(step.id, "failed", { error: message });
        await emitTaskEvent(taskId, "step.failed", { seq: step.seq, title: step.title, error: message });
        await updateTaskStatus(task.id, "failed", { error: `第 ${step.seq} 步「${step.title}」失败：${message}` });
        await notifyTaskFinished(await getTaskOrThrow(task.id), false);
        console.error(`[task-worker]   步骤 ${step.seq} 失败:`, message);
        return;
      }

      // 步骤间暂停/取消检查
      const control2 = await checkPoint(taskId, runSignal);
      if (control2 === "cancelled") {
        await emitTaskEvent(taskId, "task.cancelled", {});
        return;
      }
    }

    // ===== 完成 =====
    // 任务级完成契约（WP2）：系统判定，Agent 声称完成不生效。
    // 仅对含产物意图的任务（plan 有 artifact/dev 步骤）严格校验；纯文本任务（general 步骤）豁免。
    const hasArtifactIntent = steps.some((s) => s.worker_type === "artifact" || s.worker_type === "dev");
    if (hasArtifactIntent) {
      if (task.status === "running") {
        await updateTaskStatus(task.id, "validating").catch(() => {});
      }
      const context = await buildPlanContext(task);
      const executionPlan = buildExecutionPlan(task, context.files);
      const artifacts = await listTaskArtifacts(task.id);
      // WP12：格式验证（HTML/CSV/JSON/ZIP/PPTX/MD）——不合格进入 repair loop
      const verdict = await validateTaskCompletion(task.id, artifacts, executionPlan.contract, async (artifactId, filename, kind) => {
        const { validateArtifactFormat } = await import("../artifacts/validator");
        return validateArtifactFormat(artifactId, filename, kind);
      });
      if (verdict.status !== "completed") {
        const code = verdict.status === "retryable_failed" ? "TASK_CONTRACT_RETRYABLE" : "TASK_CONTRACT_FAILED";
        throw new Error(`${code}：${verdict.reason}`);
      }
      if (verdict.results.some((r) => !r.ok)) {
        throw new Error(`TASK_OUTPUT_VALIDATION_FAILED：${verdict.results.filter((r) => !r.ok).map((r) => `${r.filename}: ${r.error || "格式验证失败"}`).join("；")}`);
      }
    }
    // V1.4 WP32：Final Response 产物优先——完成摘要附真实产物清单（文件名+类型）
    const finalArtifacts = await listTaskArtifacts(task.id).catch(() => []);
    const artifactList = finalArtifacts.length
      ? `；产物：${finalArtifacts.map((a) => `${a.name}（${a.type}）`).join("、")}`
      : "";
    const summary = (summaryParts.length ? summaryParts.join("；") : "任务执行完成") + artifactList;
    await updateTaskStage(task.id, "完成", 100);
    await updateTaskStatus(task.id, "completed", { resultSummary: summary.slice(0, 1200) });
    await emitTaskEvent(taskId, "task.completed", { summary });
    await notifyTaskFinished(await getTaskOrThrow(task.id), true, summary);
    console.log(`[task-worker]   任务完成: ${summary.slice(0, 100)}`);
    // V1.3 WP2：Job 终态
    await updateJobStatus(job!.id, "completed");
    // V1.2 WP20：执行指标
    const artifacts = await listTaskArtifacts(task.id).catch(() => []);
    await recordTaskMetrics({
      taskId,
      userId: task.user_id,
      startedAt,
      finishedAt: Date.now(),
      retryCount: 0,
      toolCalls: 0,
      artifactCount: artifacts.length,
      runtime: policy.runtime.runtime,
      success: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // V1.3 WP19：Cancel 中断的执行 → cancelled（不是 failed）
    if (taskAbort.signal.aborted || /TASK_ABORTED|TASK_CANCELLED/.test(message)) {
      console.log(`[task-worker] 任务 ${taskId} 已取消（执行中断）`);
      await updateTaskStatus(task.id, "cancelled", { error: "用户取消" }).catch(() => {});
      await emitTaskEvent(taskId, "task.cancelled", { interrupted: true }).catch(() => {});
      await updateJobStatus(job?.id || "", "cancelled", { failure_code: "TASK_CANCELLED" }).catch(() => {});
      const current = await getTask(task.id);
      if (current) await notifyTaskFinished(current, false).catch(() => {});
      return;
    }
    console.error(`[task-worker] 任务 ${taskId} 异常:`, message);
    await updateTaskStatus(task.id, "failed", { error: message }).catch(() => {});
    await emitTaskEvent(taskId, "task.failed", { error: message }).catch(() => {});
    const current = await getTask(task.id);
    if (current) await notifyTaskFinished(current, false).catch(() => {});
    // V1.2 WP20：失败指标（failure_code 来自 FailureTaxonomy）
    const { classifyFailure } = await import("../policy/failureTaxonomy");
    const classification = classifyFailure(message);
    // V1.3 WP2：Job 失败终态（failure_code 分层）
    await updateJobStatus(job!.id, "failed", { failure_code: classification.code }).catch(() => {});
    await recordTaskMetrics({
      taskId,
      userId: task.user_id,
      startedAt,
      finishedAt: Date.now(),
      retryCount: 0,
      toolCalls: 0,
      artifactCount: 0,
      runtime: policy.runtime.runtime,
      success: false,
      failureCode: classification.code,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

/** 暂停/取消检查点：cancelled 终止；paused 等待；waiting_user 等待。 */
async function checkPoint(taskId: string, signal: AbortSignal): Promise<"ok" | "cancelled"> {
  while (!signal.aborted) {
    const row = await query<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [taskId]);
    const status = row.rows[0]?.status;
    if (status === "cancelled") return "cancelled";
    if (status === "running" || status === "planning" || status === "preparing_workspace" || status === "validating" || status === "retrying" || status === "waiting_user" || status === "completed" || status === "failed") return "ok";
    // paused：等待恢复
    await sleep(1500, signal);
  }
  return "cancelled";
}

function progressFor(taskId: string, total: number, currentSeq: number): number {
  const base = 10; // 规划占 10%
  return Math.min(98, base + Math.round(((currentSeq - 1 + 0.5) / total) * 88));
}

async function buildPlanContext(task: TaskRow) {
  const [memory, projectMemory, skills, files, projectArtifacts] = await Promise.all([
    listUserMemory(task.user_id),
    task.project_id ? listProjectMemory(task.project_id) : Promise.resolve([]),
    listEnabledSkillsText(task.user_id),
    taskFiles(task.id),
    task.project_id ? listProjectArtifactSummary(task.project_id) : Promise.resolve(""),
  ]);
  const projectContext = [
    projectMemory.map((m) => `[${m.category}] ${m.content}`).join("\n"),
    projectArtifacts,
  ].filter(Boolean).join("\n\n");
  return {
    files: files.map((file) => ({ filename: String(file.filename) })),
    projectContext,
    userMemory: memory.map((m) => `[${m.category}] ${m.content}`).join("\n"),
    skills
  };
}

/** WP26：项目历史产物摘要（多轮任务知道上轮交付了什么；供 planner/agent 上下文）。 */
export async function listProjectArtifactSummary(projectId: string): Promise<string> {
  try {
    const rows = await query<{ name: string; version: number; type: string }>(
      `SELECT a.name, a.version, a.type FROM artifacts a
       JOIN tasks t ON t.id = a.task_id
       WHERE t.project_id = $1 AND a.status = 'ready'
       ORDER BY a.created_at DESC LIMIT 10`,
      [projectId]
    );
    if (!rows.rows.length) return "";
    const lines = rows.rows.map((r) => `- ${r.name} v${r.version}（${r.type}）`);
    return `项目历史交付产物：\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

async function getTaskOrThrow(taskId: string): Promise<TaskRow> {
  const task = await getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  return task;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
