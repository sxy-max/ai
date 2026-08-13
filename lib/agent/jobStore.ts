/**
 * JobStore：Agent 运行的轻量持久化实体。
 * job 是服务端一等对象（非流上临时状态）；完整状态机/事件追加在 Job Event Stream 阶段细化。
 * 当前为进程内存储 + TTL 清理；workspace 与 Artifact Service 才是跨重启的持久化层。
 */

export type JobStatus = "queued" | "running" | "done" | "failed";

export type JobRecord = {
  id: string;
  conversationId: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  error?: string;
  artifactCount?: number;
};

const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const TERMINAL: ReadonlySet<JobStatus> = new Set(["done", "failed"]);

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();

  create(id: string, conversationId: string): JobRecord {
    const record: JobRecord = { id, conversationId, status: "queued", createdAt: Date.now() };
    this.jobs.set(id, record);
    return record;
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(conversationId?: string): JobRecord[] {
    const all = [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    return conversationId ? all.filter((job) => job.conversationId === conversationId) : all;
  }

  /** 进入 running；已终结的 job 不做状态迁移（返回 null）。 */
  start(id: string): JobRecord | null {
    return this.transition(id, "running", { startedAt: Date.now() });
  }

  complete(id: string, patch: { exitCode?: number; artifactCount?: number } = {}): JobRecord | null {
    return this.transition(id, "done", { finishedAt: Date.now(), ...patch });
  }

  fail(id: string, error: string, artifactCount?: number): JobRecord | null {
    return this.transition(id, "failed", { finishedAt: Date.now(), error, ...(artifactCount !== undefined ? { artifactCount } : {}) });
  }

  cleanupExpired(now: number = Date.now()): number {
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (now - job.createdAt > JOB_TTL_MS) {
        this.jobs.delete(id);
        removed++;
      }
    }
    return removed;
  }

  private transition(id: string, status: JobStatus, patch: Partial<JobRecord>): JobRecord | null {
    const current = this.jobs.get(id);
    if (!current) return null;
    if (TERMINAL.has(current.status) && status !== current.status) return null;
    const next = { ...current, ...patch, status };
    this.jobs.set(id, next);
    return next;
  }
}
