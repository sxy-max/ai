import { NextResponse } from "next/server";
import { accessConfigurationError, isAuthorized } from "../../../../lib/auth";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARTIFACTS_ROOT = process.env.ARTIFACTS_ROOT || "/data/artifacts";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const safeId = String(id || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);

  const confErr = accessConfigurationError();
  if (confErr) return NextResponse.json({ error: confErr }, { status: 503 });
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!safeId) return NextResponse.json({ error: "缺少 artifact id" }, { status: 400 });

  let meta: { name?: string; mime?: string; createdAt?: number } | null = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_ROOT, "manifest.json"), "utf8"));
    meta = manifest[safeId] || null;
  } catch {}
  if (!meta) return NextResponse.json({ error: "文件不存在或已过期" }, { status: 404 });

  const filePath = path.join(ARTIFACTS_ROOT, safeId);
  if (!filePath.startsWith(ARTIFACTS_ROOT + path.sep) || !fs.existsSync(filePath)) {
    return NextResponse.json({ error: "文件缺失" }, { status: 404 });
  }
  const buf = fs.readFileSync(filePath);
  const safeName = String(meta.name || "download").replace(/[^\w.\-]/g, "_");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": meta.mime || "application/octet-stream",
      "content-disposition": `attachment; filename="${safeName}"`,
      "content-length": String(buf.length),
    },
  });
}
