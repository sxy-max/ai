import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { accessConfigurationError, currentUser } from "../../../../../../lib/auth";
import { sanitizeFilename } from "../../../../../../lib/artifacts/metadata";
import { safeExtractZip } from "../../../../../../lib/workspace/zip";
import { DEFAULT_LIMITS, WorkspaceError } from "../../../../../../lib/workspace/types";
import { assertAllowedFilename, assertNoSymlinkEscape, resolveSafePath, walkWorkspace } from "../../../../../../lib/workspace/safety";
import { canAccessProject, getProjectOrThrow, workspaceRoot } from "../../../../../../lib/workbench/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_FILES = 20;
const ALLOWED = new Set([".html", ".css", ".js", ".ts", ".tsx", ".jsx", ".json", ".md", ".txt", ".py", ".sh", ".yaml", ".yml", ".csv", ".xml", ".svg", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pptx", ".docx", ".xlsx", ".pdf"]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const configurationError = accessConfigurationError();
  if (configurationError) return NextResponse.json({ error: configurationError }, { status: 503 });
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const project = await getProjectOrThrow((await params).id).catch(() => null);
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  if (!canAccessProject(project, user.id)) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  const form = await request.formData().catch(() => null);
  const files = form?.getAll("files").filter((item): item is File => item instanceof File) || [];
  if (!files.length || files.length > MAX_FILES) return NextResponse.json({ error: `请选择 1-${MAX_FILES} 个文件` }, { status: 400 });
  const root = workspaceRoot(project.agentId);
  const input = path.join(root, "input");
  fs.mkdirSync(input, { recursive: true });
  const result: Array<{ name: string; size: number }> = [];
  try {
    for (const file of files) {
      if (file.size <= 0 || file.size > DEFAULT_LIMITS.maxFileSize) throw new WorkspaceError("file_too_large", `${file.name} 大小无效或超过限制`);
      const name = sanitizeFilename(file.name);
      assertAllowedFilename(name);
      const ext = path.extname(name).toLowerCase();
      if (!ALLOWED.has(ext)) throw new WorkspaceError("zip_entry_rejected", `不支持的文件类型: ${ext || "无扩展名"}`);
      const buffer = Buffer.from(await file.arrayBuffer());
      if (ext === ".zip") {
        const written = await safeExtractZip(buffer, input, DEFAULT_LIMITS);
        result.push(...written.map((entry) => ({ name: entry, size: fs.statSync(resolveSafePath(input, entry)).size })));
      } else {
        const target = resolveSafePath(input, name);
        assertNoSymlinkEscape(root, target);
        if (fs.existsSync(target)) throw new WorkspaceError("zip_entry_rejected", `文件已存在: ${name}`);
        fs.writeFileSync(target, buffer, { flag: "wx" });
        result.push({ name, size: buffer.length });
      }
    }
    const all = walkWorkspace(root).filter((entry) => !entry.isLink);
    if (all.length > DEFAULT_LIMITS.maxFiles || all.reduce((sum, entry) => sum + entry.size, 0) > DEFAULT_LIMITS.maxTotalSize) {
      throw new WorkspaceError("total_too_large", "项目文件超过限制");
    }
    return NextResponse.json({ files: result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "文件上传失败" }, { status: error instanceof WorkspaceError ? 400 : 500 });
  }
}

