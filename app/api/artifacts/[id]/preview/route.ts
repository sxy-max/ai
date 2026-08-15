import { NextResponse } from "next/server";
import { currentUser } from "../../../../../lib/auth";
import { previewService } from "../../../../../lib/artifacts/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/artifacts/:id/preview —— 生成（缓存）Artifact 预览。 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = (await params).id;
  const kind = await guessKind(id);
  const result = await previewService.generatePreview(id, kind);
  return NextResponse.json({ ok: true, ...result });
}

/** kind 从 artifact 记录推断（type 字段）。 */
async function guessKind(id: string): Promise<string> {
  const { artifactService } = await import("../../../../../lib/artifacts/service");
  const artifact = artifactService.list().find((a) => a.id === id);
  return artifact?.kind || "unknown";
}
