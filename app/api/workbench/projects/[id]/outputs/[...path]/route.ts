import path from "node:path";
import { NextResponse } from "next/server";
import { accessConfigurationError, currentUser } from "../../../../../../../lib/auth";
import { contentDisposition } from "../../../../../../../lib/artifacts/metadata";
import { getProjectOrThrow, getRuntimeClient } from "../../../../../../../lib/workbench/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  const configurationError = accessConfigurationError();
  if (configurationError) return NextResponse.json({ error: configurationError }, { status: 503 });
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const values = await params;
    const project = await getProjectOrThrow(values.id);
    if (project.ownerId && project.ownerId !== user.id) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    const relative = values.path.join("/");
    if (!relative || relative.includes("..") || relative.includes("\\") || path.posix.normalize(relative) !== relative) {
      return NextResponse.json({ error: "文件路径无效" }, { status: 400 });
    }
    const client = getRuntimeClient();
    const listing = await client.listDirectory(project.agentId, project.sessionId, "outputs");
    const entry = listing.entries.find((item) => item.name === relative && !item.is_dir && (item.size_bytes || 0) > 0);
    if (!entry) return NextResponse.json({ error: "输出文件不存在" }, { status: 404 });
    const upstream = await client.readFile(project.agentId, project.sessionId, `outputs/${relative}`);
    return new Response(upstream.body, { headers: {
      "content-type": upstream.headers.get("content-type") || "application/octet-stream",
      "content-length": String(entry.size_bytes),
      "content-disposition": contentDisposition(entry.name),
      "cache-control": "private, no-store"
    } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "下载失败" }, { status: 502 });
  }
}

