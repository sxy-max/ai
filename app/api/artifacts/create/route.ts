import { NextResponse } from "next/server";
import { accessConfigurationError, isAuthorized } from "../../../../lib/auth";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARTIFACTS_ROOT = process.env.ARTIFACTS_ROOT || "/data/artifacts";
const MAX_CONTENT = 500 * 1024;

export async function POST(request: Request) {
  const confErr = accessConfigurationError();
  if (confErr) return NextResponse.json({ error: confErr }, { status: 503 });
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const name = String(body?.name || "file").replace(/[^\w.\-]/g, "_").slice(0, 120) || "file";
  const content = typeof body?.content === "string" ? body.content : "";
  const mime = String(body?.mime || "text/plain").slice(0, 100);
  if (!content || content.length > MAX_CONTENT) {
    return NextResponse.json({ error: "内容无效或超过 500KB" }, { status: 400 });
  }

  const id = randomUUID();
  let manifest: Record<string, any> = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_ROOT, "manifest.json"), "utf8"));
  } catch {}
  try {
    fs.mkdirSync(ARTIFACTS_ROOT, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS_ROOT, id), content, "utf8");
    manifest[id] = { name, mime, size: Buffer.byteLength(content, "utf8"), createdAt: Date.now() };
    fs.writeFileSync(path.join(ARTIFACTS_ROOT, "manifest.json"), JSON.stringify(manifest));
  } catch {
    return NextResponse.json({ error: "保存失败" }, { status: 500 });
  }
  return NextResponse.json({ id, name, mime, size: manifest[id].size, downloadUrl: `/api/artifacts/${id}` });
}
