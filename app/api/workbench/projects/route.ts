import { NextResponse } from "next/server";
import { accessConfigurationError, currentUser } from "../../../../lib/auth";
import { projectStore } from "../../../../lib/workbench/projectStore";
import { provisionProject } from "../../../../lib/workbench/projectService";
import { canAccessProject } from "../../../../lib/workbench/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function guard(request: Request) {
  const error = accessConfigurationError();
  if (error) return { response: NextResponse.json({ error }, { status: 503 }) as NextResponse | null, user: null };
  const user = await currentUser(request);
  if (!user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }), user: null };
  return { response: null, user };
}

export async function GET(request: Request) {
  const { response, user } = await guard(request);
  if (response) return response;
  const projects = await projectStore.list();
  return NextResponse.json({ projects: projects.filter((project) => canAccessProject(project, user!.id)) });
}

export async function POST(request: Request) {
  const { response, user } = await guard(request);
  if (response) return response;
  try {
    const body = await request.json();
    const name = typeof body?.name === "string" ? body.name : "";
    if (!name.trim()) return NextResponse.json({ error: "项目名称不能为空" }, { status: 400 });
    return NextResponse.json({ project: await provisionProject(name, user!.id) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建项目失败" }, { status: 502 });
  }
}
