/** Task 产物注册：文件进 Artifact Service（磁盘），元数据进 PG artifacts 表（版本化）。 */

import { randomUUID } from "node:crypto";
import { artifactService } from "../artifacts/service";
import { query } from "../db/pool";
import type { ArtifactKind } from "../artifacts/types";
import { emitTaskEvent } from "./repo";
import type { TaskEventType } from "./types";

export type RegisterArtifactInput = {
  taskId: string;
  userId: string;
  projectId?: string | null;
  filename: string;
  content: Buffer | string;
  kind: ArtifactKind;
  mime?: string;
  /** 对外展示名（默认 filename 去扩展名）；同一 task+name 递增版本。 */
  name?: string;
};

export type TaskArtifactRow = {
  id: string;
  task_id: string;
  type: string;
  name: string;
  version: number;
  size: number;
  mime: string;
  status: string;
  created_at: Date;
};

/** 注册任务产物：落盘 + PG 登记（V1/V2 版本化，并发冲突自动重试）+ 事件广播。 */
export async function registerTaskArtifact(input: RegisterArtifactInput): Promise<TaskArtifactRow> {
  const artifact = artifactService.createArtifact({
    filename: input.filename,
    content: input.content,
    kind: input.kind,
    mimeType: input.mime,
    source: "agent"
  });

  const displayName = input.name || input.filename.replace(/\.[^.]+$/, "") || input.filename;

  // 版本化并发安全：UNIQUE(task_id,name,version) 冲突时重算版本重试（最多 8 次，覆盖同批高并发）
  let row: TaskArtifactRow | null = null;
  for (let attempt = 0; attempt < 8 && !row; attempt++) {
    const versionResult = await query<{ next: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM artifacts WHERE task_id = $1 AND name = $2`,
      [input.taskId, displayName]
    );
    const version = Number(versionResult.rows[0]?.next ?? 1);
    try {
      const inserted = await query<TaskArtifactRow>(
        `INSERT INTO artifacts (id, user_id, task_id, project_id, type, name, version, storage_key, file_url, size, mime, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ready')
         ON CONFLICT (task_id, name, version) DO NOTHING
         RETURNING id, task_id, type, name, version, size, mime, status, created_at`,
        [
          artifact.id,
          input.userId,
          input.taskId,
          input.projectId ?? null,
          input.kind,
          displayName,
          version,
          artifact.id,
          `/api/artifacts/${artifact.id}`,
          artifact.size,
          artifact.mimeType
        ]
      );
      if (inserted.rows[0]) row = inserted.rows[0];
    } catch (error) {
      // 非版本冲突的插入错误直接抛
      if (attempt === 7) throw error;
    }
  }
  if (!row) throw new Error("ARTIFACT_REGISTER_FAILED：产物版本冲突重试耗尽");

  await emitTaskEvent(input.taskId, "artifact.created", {
    artifactId: artifact.id,
    name: displayName,
    filename: input.filename,
    version: row.version,
    kind: input.kind,
    downloadUrl: `/api/artifacts/${artifact.id}`,
    size: artifact.size
  });

  return row;
}

/** 下载事件（工具调用记录用）。 */
export function emitToolEvent(taskId: string, name: string, args: Record<string, unknown> = {}, result?: { ok: boolean; output?: string }) {
  const base: { type: TaskEventType; payload: Record<string, unknown> }[] = [
    { type: "tool.started", payload: { name, args: { ...args } } }
  ];
  if (result) base.push({ type: "tool.completed", payload: { name, ok: result.ok, output: result.output?.slice(0, 2000) } });
  for (const event of base) void emitTaskEvent(taskId, event.type, event.payload);
}

/** 列出任务的产物（最新版本优先）。 */
export async function listTaskArtifacts(taskId: string): Promise<TaskArtifactRow[]> {
  const result = await query<TaskArtifactRow>(
    `SELECT id, task_id, type, name, version, size, mime, status, created_at
     FROM artifacts WHERE task_id = $1 ORDER BY created_at DESC`,
    [taskId]
  );
  return result.rows;
}

export function taskArtifactId(): string {
  return randomUUID();
}
