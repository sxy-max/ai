import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OutputEntry, RunFailureReason } from "./types";

export type RunRecord = {
  id: string;
  projectId: string;
  task: string;
  finalStatus: "completed" | "failed";
  reason?: RunFailureReason;
  outputs: OutputEntry[];
  createdAt: string;
};

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export class RunStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly root: string;

  constructor(root = process.env.GO_AI_CONTROL_ROOT || "/data/go-ai-control") {
    this.root = path.resolve(root, "runs");
  }

  private dir(projectId: string) {
    if (!SAFE_ID.test(projectId)) throw new Error("INVALID_PROJECT_ID");
    return path.join(this.root, projectId);
  }

  private file(projectId: string, id: string) {
    if (!SAFE_ID.test(id)) throw new Error("INVALID_RUN_ID");
    const target = path.join(this.dir(projectId), `${id}.json`);
    if (path.dirname(target) !== this.dir(projectId)) throw new Error("INVALID_RUN_ID");
    return target;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async save(input: { projectId: string; task: string; finalStatus: RunRecord["finalStatus"]; reason?: RunFailureReason; outputs: OutputEntry[] }): Promise<RunRecord> {
    return this.serialize(async () => {
      const id = randomUUID();
      const record: RunRecord = {
        id,
        projectId: input.projectId,
        task: input.task.slice(0, 2000),
        finalStatus: input.finalStatus,
        reason: input.reason,
        outputs: input.outputs,
        createdAt: new Date().toISOString()
      };
      await fs.mkdir(this.dir(input.projectId), { recursive: true });
      await fs.writeFile(this.file(input.projectId, id), JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx" });
      return record;
    });
  }

  async latest(projectId: string): Promise<RunRecord | null> {
    try {
      const names = (await fs.readdir(this.dir(projectId))).filter((name) => name.endsWith(".json") && SAFE_ID.test(name.slice(0, -5)));
      if (!names.length) return null;
      const records = await Promise.all(names.map((name) => this.read(projectId, name.slice(0, -5)).catch(() => null)));
      const valid = records.filter((item): item is RunRecord => item !== null);
      valid.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return valid[0] || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async read(projectId: string, id: string): Promise<RunRecord | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.file(projectId, id), "utf8")) as Partial<RunRecord>;
      if (value.id !== id || !value.projectId || !value.task || !value.finalStatus || !Array.isArray(value.outputs) || !value.createdAt) {
        throw new Error("CORRUPT_RUN_RECORD");
      }
      return value as RunRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

export const runStore = new RunStore();
