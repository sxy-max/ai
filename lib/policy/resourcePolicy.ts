/**
 * ResourcePolicy（V1.3 WP28）：资源治理——不让一个任务吃光服务器。
 * maxConcurrentJobs / maxSandboxes / perSandboxMemory / perSandboxCPU /
 * perJobTimeout / maxWorkspaceSize / maxArtifactSize / maxToolCalls / maxSteps。
 * 达到容量 → 任务保持 queued（不一起启动然后 OOM）。
 */

export type ResourcePolicy = {
  maxConcurrentJobs: number;
  maxSandboxes: number;
  perSandboxMemoryMb: number;
  perSandboxCpu: number;
  perJobTimeoutMs: number;
  maxWorkspaceSizeMb: number;
  maxArtifactSizeMb: number;
  maxToolCalls: number;
  maxSteps: number;
};

export function loadResourcePolicy(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): ResourcePolicy {
  const num = (key: string, fallback: number) => {
    const v = Number(env[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    maxConcurrentJobs: num("RESOURCE_MAX_CONCURRENT_JOBS", 2),
    maxSandboxes: num("RESOURCE_MAX_SANDBOXES", 2),
    perSandboxMemoryMb: num("RESOURCE_SANDBOX_MEMORY_MB", 512),
    perSandboxCpu: num("RESOURCE_SANDBOX_CPU", 0.5),
    perJobTimeoutMs: num("RESOURCE_JOB_TIMEOUT_MS", 15 * 60 * 1000),
    maxWorkspaceSizeMb: num("RESOURCE_MAX_WORKSPACE_MB", 500),
    maxArtifactSizeMb: num("RESOURCE_MAX_ARTIFACT_MB", 50),
    maxToolCalls: num("RESOURCE_MAX_TOOL_CALLS", 200),
    maxSteps: num("RESOURCE_MAX_STEPS", 12),
  };
}

/** 超限检查结果。 */
export type ResourceCheck = { ok: boolean; reason?: string };

/** 步骤数检查（planner 后/执行前）。 */
export function checkSteps(stepCount: number, policy: ResourcePolicy): ResourceCheck {
  if (stepCount > policy.maxSteps) {
    return { ok: false, reason: `步骤数超限（${stepCount} > ${policy.maxSteps}）` };
  }
  return { ok: true };
}

/** 工具调用数检查（AgentSession tool_calls 超限）。 */
export function checkToolCalls(toolCalls: number, policy: ResourcePolicy): ResourceCheck {
  if (toolCalls > policy.maxToolCalls) {
    return { ok: false, reason: `工具调用超限（${toolCalls} > ${policy.maxToolCalls}）` };
  }
  return { ok: true };
}

/** 产物大小检查。 */
export function checkArtifactSize(bytes: number, policy: ResourcePolicy): ResourceCheck {
  const limit = policy.maxArtifactSizeMb * 1024 * 1024;
  if (bytes > limit) {
    return { ok: false, reason: `产物超限（${Math.round(bytes / 1024 / 1024)}MB > ${policy.maxArtifactSizeMb}MB）` };
  }
  return { ok: true };
}

/** 并发任务容量检查（多 worker 共享时：当前 running 任务数 >= max → 不领取）。 */
export function checkConcurrentCapacity(currentRunning: number, policy: ResourcePolicy): ResourceCheck {
  if (currentRunning >= policy.maxConcurrentJobs) {
    return { ok: false, reason: `并发任务已达上限（${currentRunning}/${policy.maxConcurrentJobs}）` };
  }
  return { ok: true };
}
