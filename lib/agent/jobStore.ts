/**
 * JobStore：Agent 任务的进程内持久化实体。
 * 状态机走完整 JobStatus union（Job Event Stream 定义）；job 是服务端一等对象，
 * workspace 与 Artifact Service 才是跨重启的持久化层。
 */

import type { JobStatus } from "../job/events";

export type { JobStatus };

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

  /** 状态迁移：已终结的 job 拒绝任何后续迁移（返回 null）；首条非 queued 记录 startedAt。 */
  updateStatus(id: string, status: JobStatus, patch: Partial<JobRecord> = {}): JobRecord | null {
    const current = this.jobs.get(id);
    if (!current) return null;
    if (TERMINAL.has(current.status) && status !== current.status) return null;
    const startedAt = current.status === "queued" && status !== "queued" && !current.startedAt ? Date.now() : current.startedAt;
    const finishedAt = TERMINAL.has(status) ? Date.now() : current.finishedAt;
    const next = { ...current, ...patch, status, startedAt, finishedAt };
    this.jobs.set(id, next);
    return next;
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
}
