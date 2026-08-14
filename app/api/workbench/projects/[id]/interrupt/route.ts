import { NextResponse } from "next/server";
import { accessConfigurationError, currentUser } from "../../../../../../lib/auth";
import { canAccessProject, getProjectOrThrow, getRuntimeClient } from "../../../../../../lib/workbench/runtime";

export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const error = accessConfigurationError();
  if (error) return NextResponse.json({ error }, { status: 503 });
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const project = await getProjectOrThrow((await params).id);
    if (!canAccessProject(project, user.id)) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    await getRuntimeClient().interrupt(project.agentId, project.sessionId);
    return NextResponse.json({ ok: true });
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : "停止失败" }, { status: 502 });
  }
}

