import { createAgentScopeClient } from "../agentscope/client";
import { projectStore, type Project } from "./projectStore";

export const INTERNAL_USER_ID = "owner";

/** 项目归属校验：ownerId 为空 = 旧版共享项目（多用户上线前创建），否则必须匹配当前用户。 */
export function canAccessProject(project: Project, userId: string): boolean {
  return !project.ownerId || project.ownerId === userId;
}

export function getRuntimeClient() {
  const baseUrl = process.env.AGENTSCOPE_URL?.trim();
  if (!baseUrl) throw new Error("AGENTSCOPE_URL is required");
  return createAgentScopeClient({ baseUrl, userId: INTERNAL_USER_ID });
}

export async function getProjectOrThrow(id: string) {
  const project = await projectStore.get(id);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  return project;
}

export function workspaceRoot(agentId: string) {
  const base = process.env.AGENTSCOPE_WORKSPACE_ROOT?.trim();
  if (!base) throw new Error("AGENTSCOPE_WORKSPACE_ROOT is required");
  return `${base.replace(/[\\/]$/, "")}/${INTERNAL_USER_ID}/${agentId}`;
}

