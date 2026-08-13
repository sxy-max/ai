import { NextResponse } from "next/server";
import { accessConfigurationError, isAuthorized } from "../../../../lib/auth";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || "/data/workspaces";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 20;
const ALLOWED_EXT = new Set([
  ".html", ".css", ".js", ".ts", ".tsx", ".jsx", ".json", ".md", ".txt",
  ".py", ".sh", ".yaml", ".yml", ".csv", ".xml", ".svg", ".zip",
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
]);

function safeName(name: string) {
  const base = path.basename(String(name || "").replace(/\\/g, "/")).replace(/[^\w.\-]/g, "_");
  return base || "file";
}

export async function POST(request: Request) {
  const confErr = accessConfigurationError();
  if (confErr) return NextResponse.json({ error: confErr }, { status: 503 });
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const conv = String(request.url.includes("conversationId") ? new URL(request.url).searchParams.get("conversationId") : "default")
    .replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";
  const job = String(new URL(request.url).searchParams.get("jobId") || "default")
    .replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";

  const wsDir = path.join(WORKSPACES_ROOT, conv, job);
  try {
    fs.mkdirSync(wsDir, { recursive: true });
  } catch {
    return NextResponse.json({ error: "Workspace 创建失败" }, { status: 500 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "multipart/form-data 必填" }, { status: 400 });
  const files = form.getAll("files").filter((x): x is File => x instanceof File);
  if (!files.length) return NextResponse.json({ error: "没有文件" }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: "一次最多 20 个文件" }, { status: 400 });

  const results: { fileRef: string; name: string; mime: string; size: number }[] = [];
  for (const f of files) {
    const ext = path.extname(f.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return NextResponse.json({ error: `不支持的文件类型: ${ext}` }, { status: 400 });
    if (f.size > MAX_FILE_BYTES) return NextResponse.json({ error: `${f.name} 超过 20MB` }, { status: 413 });
    const safe = safeName(f.name);
    const dest = path.join(wsDir, safe);
    if (!dest.startsWith(wsDir + path.sep) && dest !== wsDir) {
      return NextResponse.json({ error: "非法路径" }, { status: 400 });
    }
    const buf = Buffer.from(await f.arrayBuffer());
    fs.writeFileSync(dest, buf);
    results.push({ fileRef: `${conv}/${job}/${safe}`, name: safe, mime: f.type || "application/octet-stream", size: buf.length });
  }
  return NextResponse.json({ files: results, conversationId: conv, jobId: job });
}
