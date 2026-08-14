import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type Project = {
  id: string;
  name: string;
  agentId: string;
  sessionId: string;
  /** 归属用户；旧版记录为空字符串 = 兼容共享（多用户上线前创建的项目）。 */
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export class ProjectStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly root: string;

  constructor(root = process.env.GO_AI_CONTROL_ROOT || "/data/go-ai-control") {
    this.root = path.resolve(root, "projects");
  }

  private file(id: string) {
    if (!SAFE_ID.test(id)) throw new Error("INVALID_PROJECT_ID");
    const target = path.resolve(this.root, `${id}.json`);
    if (path.dirname(target) !== this.root) throw new Error("INVALID_PROJECT_ID");
    return target;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<Project[]> {
    await fs.mkdir(this.root, { recursive: true });
    const names = (await fs.readdir(this.root)).filter((name) => SAFE_ID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"));
    const projects = await Promise.all(names.map((name) => this.get(name.slice(0, -5))));
    return projects.filter((item): item is Project => item !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Project | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.file(id), "utf8")) as Partial<Project>;
      if (value.id !== id || !value.name || !value.agentId || !value.sessionId || !value.createdAt || !value.updatedAt) {
        throw new Error("CORRUPT_PROJECT_RECORD");
      }
      if (!SAFE_ID.test(value.agentId) || !SAFE_ID.test(value.sessionId)) throw new Error("CORRUPT_PROJECT_RECORD");
      return { ...(value as Project), ownerId: value.ownerId || "" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async create(input: { name: string; agentId: string; sessionId: string; ownerId?: string; id?: string }): Promise<Project> {
    return this.serialize(async () => {
      const id = input.id || randomUUID();
      if (!SAFE_ID.test(input.agentId) || !SAFE_ID.test(input.sessionId)) throw new Error("INVALID_RUNTIME_ID");
      const name = input.name.trim().slice(0, 120);
      if (!name) throw new Error("PROJECT_NAME_REQUIRED");
      if (await this.get(id)) throw new Error("PROJECT_EXISTS");
      const now = new Date().toISOString();
      const project: Project = { id, name, agentId: input.agentId, sessionId: input.sessionId, ownerId: input.ownerId || "", createdAt: now, updatedAt: now };
      await fs.mkdir(this.root, { recursive: true });
      const target = this.file(id);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(project, null, 2), { encoding: "utf8", flag: "wx" });
      await fs.rename(temporary, target);
      return project;
    });
  }
}

export const projectStore = new ProjectStore();

