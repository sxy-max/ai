/** Memory 数据访问（PRD §41-§43）：User Memory / Project Memory。 */

import { query } from "../db/pool";

export type MemoryRow = {
  id: string;
  category: string;
  content: string;
  created_at: Date;
  updated_at: Date;
};

export async function listUserMemory(userId: string): Promise<MemoryRow[]> {
  const result = await query<MemoryRow>("SELECT * FROM user_memory WHERE user_id = $1 ORDER BY updated_at DESC", [userId]);
  return result.rows;
}

export async function addUserMemory(userId: string, category: string, content: string, source = "manual") {
  const result = await query<MemoryRow>(
    `INSERT INTO user_memory (user_id, category, content, source) VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, category, content.trim(), source]
  );
  return result.rows[0];
}

export async function deleteUserMemory(userId: string, id: string) {
  await query("DELETE FROM user_memory WHERE id = $1 AND user_id = $2", [id, userId]);
}

export async function listProjectMemory(projectId: string): Promise<MemoryRow[]> {
  const result = await query<MemoryRow>("SELECT * FROM project_memory WHERE project_id = $1 ORDER BY updated_at DESC", [projectId]);
  return result.rows;
}

export async function addProjectMemory(projectId: string, category: string, content: string) {
  const result = await query<MemoryRow>(
    `INSERT INTO project_memory (project_id, category, content) VALUES ($1, $2, $3) RETURNING *`,
    [projectId, category, content.trim()]
  );
  return result.rows[0];
}

export async function deleteProjectMemory(projectId: string, id: string) {
  await query("DELETE FROM project_memory WHERE id = $1 AND project_id = $2", [id, projectId]);
}

/** 用户偏好摘要（注入 planner / worker system 提示）。 */
export function memorySummary(rows: MemoryRow[]): string {
  return rows.map((row) => `[${row.category}] ${row.content}`).join("\n");
}
