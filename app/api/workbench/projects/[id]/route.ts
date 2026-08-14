import { NextResponse } from "next/server";
import { accessConfigurationError, currentUser } from "../../../../../lib/auth";
import { canAccessProject, getProjectOrThrow, getRuntimeClient } from "../../../../../lib/workbench/runtime";
import { runStore } from "../../../../../lib/workbench/runStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const error = accessConfigurationError();
  if (error) return NextResponse.json({ error }, { status: 503 });
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const project = await getProjectOrThrow((await params).id);
    if (!canAccessProject(project, user.id)) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    const client = getRuntimeClient();
    const [status, workspace, input, outputs, latestRun] = await Promise.all([
      client.getSessionStatus(project.agentId, project.sessionId),
      client.workspaceStatus(project.agentId, project.sessionId),
      client.listDirectory(project.agentId, project.sessionId, "input").catch(() => ({ path: "input", entries: [] })),
      client.listDirectory(project.agentId, project.sessionId, "outputs").catch(() => ({ path: "outputs", entries: [] })),
      runStore.latest(project.id).catch(() => null)
    ]);
    return NextResponse.json({ project, status, workspace, input: input.entries, outputs: outputs.entries, latestRun });
  } catch (cause) {
    const status = cause instanceof Error && cause.message === "PROJECT_NOT_FOUND" ? 404 : 502;
    return NextResponse.json({ error: cause instanceof Error ? cause.message : "项目读取失败" }, { status });
  }
}

