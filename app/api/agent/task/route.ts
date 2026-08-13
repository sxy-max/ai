import { NextResponse } from "next/server";
import { accessConfigurationError, isAuthorized } from "../../../../lib/auth";
import path from "node:path";
import { artifactService } from "../../../../lib/artifacts/service";
import type { ClientArtifact } from "../../../../lib/artifacts/types";
import { WorkspaceManager } from "../../../../lib/workspace/service";
import { GoFileAgentAdapter } from "../../../../lib/sandbox/dockerClaudeCode";
import { JobStore } from "../../../../lib/agent/jobStore";
import { runAgentJob } from "../../../../lib/agent/runner";
import { serializeJobEvent } from "../../../../lib/job/events";
import type { JobEvent } from "../../../../lib/job/events";
import { scanWorkspaceVision } from "../../../../lib/vision/workspaceScanner";
import { registerWorkspaceManifest } from "../../../../lib/files/processor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || "/data/workspaces";
const jobStore = new JobStore();

export async function POST(request: Request) {
  const confErr = accessConfigurationError();
  if (confErr) return NextResponse.json({ error: confErr }, { status: 503 });
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body.prompt !== "string" || !body.prompt.trim() || !body.jobId) {
    return NextResponse.json({ error: "prompt 与 jobId 必填" }, { status: 400 });
  }
  const conv = String(body.conversationId || "default").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";
  const job = String(body.jobId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";
  const ws = new WorkspaceManager(path.join(WORKSPACES_ROOT, conv, job));
  try {
    ws.createWorkspace();
  } catch {
    return NextResponse.json({ error: "Workspace 创建失败" }, { status: 500 });
  }

  registerWorkspaceManifest(ws);
  const vision = await scanWorkspaceVision(ws, process.env.OPENCODE_GO_API_KEY || "");
  const visionMd = vision.visionMd;

  const adapter = new GoFileAgentAdapter();
  const registerArtifact = async (name: string, content: Buffer): Promise<ClientArtifact | null> => {
    try {
      const artifact = artifactService.createArtifact({
        filename: name,
        content,
        source: "file_agent",
        jobId: job,
        metadata: { workspace: `${conv}/${job}` },
      });
      return artifactService.serializeArtifactForClient(artifact);
    } catch {
      return null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = (s: string) => controller.enqueue(new TextEncoder().encode(s));
      const emitWire = (event: JobEvent) => enc(serializeJobEvent(event));
      try {
        await runAgentJob(
          {
            conversationId: conv,
            jobId: job,
            prompt: String(body.prompt).slice(0, 8000),
            maxTurns: Number(body.maxTurns) || 15,
            memory: Array.isArray(body.memory) ? body.memory.map(String).slice(0, 20) : [],
            style: body.style ? String(body.style).slice(0, 500) : "",
            skills: Array.isArray(body.skills) ? body.skills.map(String).slice(0, 20) : [],
            visionMd,
            fileManifest: true,
            workspace: ws,
            adapter,
            store: jobStore,
            registerArtifact,
          },
          emitWire
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        enc(serializeJobEvent({ type: "error", code: "internal", message: message || "文件处理失败" }));
      }
      controller.close();
    },
    cancel() {},
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform" },
  });
}
