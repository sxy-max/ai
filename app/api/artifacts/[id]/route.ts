import { NextResponse } from "next/server";
import { accessConfigurationError, isAuthorized } from "../../../../lib/auth";
import { artifactService } from "../../../../lib/artifacts/service";
import { sanitizeFilename } from "../../../../lib/artifacts/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const confErr = accessConfigurationError();
  if (confErr) return NextResponse.json({ error: confErr }, { status: 503 });
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!String(id || "").trim()) return NextResponse.json({ error: "缺少 artifact id" }, { status: 400 });

  const artifact = artifactService.getArtifact(id);
  if (!artifact) return NextResponse.json({ error: "文件不存在或已过期" }, { status: 404 });
  if (artifact.status === "expired") return NextResponse.json({ error: "文件已过期" }, { status: 404 });

  const buf = artifactService.readContent(artifact.id);
  if (!buf) return NextResponse.json({ error: "文件缺失" }, { status: 404 });

  const safeName = sanitizeFilename(artifact.filename);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": artifact.mimeType,
      "content-disposition": `attachment; filename="${safeName}"`,
      "content-length": String(buf.length),
    },
  });
}
