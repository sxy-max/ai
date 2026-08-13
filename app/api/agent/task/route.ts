import { NextResponse } from "next/server";
import { accessConfigurationError, isAuthorized } from "../../../../lib/auth";
import fs from "node:fs";
import path from "node:path";
import { describeImageBase64 } from "../../../../lib/vision";
import { artifactService } from "../../../../lib/artifacts/service";
import type { ClientArtifact } from "../../../../lib/artifacts/types";
import { WorkspaceManager } from "../../../../lib/workspace/service";
import { walkWorkspace } from "../../../../lib/workspace/safety";
import { GoFileAgentAdapter } from "../../../../lib/sandbox/dockerClaudeCode";
import { JobStore } from "../../../../lib/agent/jobStore";
import { runAgentJob, type JobRunEvent } from "../../../../lib/agent/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || "/data/workspaces";
const jobStore = new JobStore();

async function describeImage(filePath: string): Promise<string> {
  const key = process.env.OPENCODE_GO_API_KEY;
  if (!key) return "";
  const ext = path.extname(filePath).toLowerCase();
  const media = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/png";
  const data = fs.readFileSync(filePath).toString("base64");
  return describeImageBase64(`data:${media};base64,${data}`, key);
}

/** 扫描 workspace 图片 → MiniMax 描述 → 写入 .go-ai/vision/*.md。Phase F 收归 lib/vision/workspaceScanner。 */
async function scanWorkspaceVision(ws: WorkspaceManager): Promise<boolean> {
  let visionMd = false;
  try {
    const images = walkWorkspace(ws.root).filter((f) => !f.isLink && /\.(png|jpe?g|gif|webp)$/i.test(f.relPath));
    for (const f of images) {
      const desc = await describeImage(f.absPath);
      if (desc) {
        const vDir = path.join(ws.dirs.internal, "vision");
        fs.mkdirSync(vDir, { recursive: true });
        const base = path.basename(f.relPath, path.extname(f.relPath));
        fs.writeFileSync(path.join(vDir, base + ".md"), desc);
        visionMd = true;
      }
    }
  } catch {}
  return visionMd;
}

/** 把 Runner 的收敛事件转回当前 wire 事件类型（前端兼容；Phase E 收敛 union 后简化）。 */
function toWire(event: JobRunEvent): Record<string, unknown> | null {
  switch (event.type) {
    case "tool":
      return { type: "agent_tool", name: event.name, ...(event.detail ? { detail: event.detail } : {}) };
    case "text":
      return { type: "agent_text", text: event.text };
    case "result":
      return { type: "agent_result", result: event.result };
    case "artifacts":
      return { type: "artifacts", files: event.files };
    case "done":
      return { type: "done", exitCode: event.exitCode ?? 0, durationMs: event.durationMs };
    case "error":
      return { type: "agent_error", message: event.message };
    case "job_status":
      return null; // 当前前端不消费；Phase G Job UI 消费
  }
}

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

  const visionMd = await scanWorkspaceVision(ws);

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
      const emitWire = (event: JobRunEvent) => {
        const line = toWire(event);
        if (line) enc(JSON.stringify(line) + "\n");
      };
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
            workspace: ws,
            adapter,
            store: jobStore,
            registerArtifact,
          },
          emitWire
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        enc(JSON.stringify({ type: "agent_error", message: message || "文件处理失败" }) + "\n");
      }
      controller.close();
    },
    cancel() {},
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform" },
  });
}
