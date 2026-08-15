/**
 * Project API 助手（V1.4 WP37-39）：项目详情 = 任务 + 产物历史（版本化）+ workspace 文件树。
 * 文件树读 WORKSPACES_ROOT/projects/{projectId}（项目模式任务共享的持久工作区）。
 */
import fs from "node:fs";
import path from "node:path";
import { query } from "../db/pool";

// 运行时读取（模块级常量会被 ESM import 提升捕获旧 env，测试无法覆盖）
function workspacesRoot(): string {
  return process.env.WORKSPACES_ROOT || "/data/workspaces";
}

export type ProjectRow = { id: string; name: string; description: string; status: string; created_at: string };

export async function listProjects(userId: string): Promise<Array<ProjectRow & { taskCount: number; artifactCount: number; updated_at: string }>> {
  const result = await query(
    `SELECT p.*,
       (SELECT count(*) FROM tasks t WHERE t.project_id = p.id)::int AS task_count,
       (SELECT count(*) FROM artifacts a WHERE a.project_id = p.id)::int AS artifact_count
     FROM projects p WHERE p.user_id = $1 ORDER BY p.updated_at DESC`,
    [userId]
  );
  return result.rows.map((r) => ({
    id: String(r.id), name: String(r.name), description: String(r.description || ""),
    status: String(r.status), created_at: String(r.created_at), updated_at: String(r.updated_at || r.created_at),
    taskCount: Number(r.task_count || 0), artifactCount: Number(r.artifact_count || 0),
  }));
}

export async function getProject(userId: string, projectId: string): Promise<ProjectRow | null> {
  const result = await query("SELECT * FROM projects WHERE id = $1 AND user_id = $2", [projectId, userId]);
  return result.rows[0] ? { id: String(result.rows[0].id), name: String(result.rows[0].name), description: String(result.rows[0].description || ""), status: String(result.rows[0].status), created_at: String(result.rows[0].created_at) } : null;
}

/** 项目产物历史（按 name 分组版本序列，WP39：site-v1/v2/v3、report-v1.docx…）。 */
export async function projectArtifacts(userId: string, projectId: string): Promise<Array<{
  id: string; name: string; type: string; version: number; size: number; mime: string;
  taskId: string | null; createdAt: string; downloadUrl: string;
}>> {
  const result = await query(
    `SELECT id, name, type, version, size, mime, task_id, created_at
     FROM artifacts WHERE project_id = $1 AND user_id = $2 AND status = 'ready'
     ORDER BY name ASC, version ASC`,
    [projectId, userId]
  );
  return result.rows.map((r) => ({
    id: String(r.id), name: String(r.name), type: String(r.type), version: Number(r.version),
    size: Number(r.size || 0), mime: String(r.mime || ""), taskId: r.task_id ? String(r.task_id) : null,
    createdAt: String(r.created_at), downloadUrl: `/api/artifacts/${r.id}`,
  }));
}

/** 项目任务列表（含进度）。 */
export async function projectTasks(userId: string, projectId: string): Promise<Array<Record<string, unknown>>> {
  const result = await query(
    `SELECT id, title, goal, status, type, progress, result_summary, created_at, completed_at
     FROM tasks WHERE project_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
    [projectId, userId]
  );
  return result.rows.map((r) => ({ ...r, id: String(r.id) }));
}

export type WorkspaceFileEntry = {
  name: string; path: string; dir: boolean; size: number; modified: number;
  artifactName?: string;
};

/** workspace 文件树（WP38：tree/size/type/modified；input 文件标注 artifact 名）。 */
export function projectFiles(projectId: string): WorkspaceFileEntry[] {
  const root = path.join(workspacesRoot(), "projects", projectId);
  if (!fs.existsSync(root)) return [];
  const out: WorkspaceFileEntry[] = [];
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        out.push({ name: entry.name, path: childRel, dir: true, size: 0, modified: 0 });
        walk(childRel);
      } else {
        try {
          const stat = fs.statSync(childAbs);
          out.push({
            name: entry.name,
            path: childRel,
            dir: false,
            size: stat.size,
            modified: stat.mtimeMs,
            // input/ 下文件即原始上传（artifact 名 = 文件名去扩展名）
            artifactName: rel === "input" ? entry.name.replace(/\.[^.]+$/, "") : undefined,
          });
        } catch {}
      }
    }
  };
  walk("");
  return out;
}
