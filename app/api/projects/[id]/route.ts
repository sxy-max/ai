import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
import { getProject, projectArtifacts, projectTasks, projectFiles } from "../../../../lib/projects/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/projects/:id —— 项目详情：任务 + 产物历史（版本化）+ workspace 文件树。 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = (await params).id;
  const project = await getProject(user.id, id);
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  const [artifacts, tasks, files] = await Promise.all([
    projectArtifacts(user.id, id),
    projectTasks(user.id, id),
    Promise.resolve(projectFiles(id)),
  ]);
  return NextResponse.json({ ok: true, project, artifacts, tasks, files });
}
