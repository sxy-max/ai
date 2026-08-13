import { NextResponse } from "next/server";
import { accessConfigurationError, isAuthorized } from "../../../../lib/auth";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describeImageBase64 } from "../../../../lib/vision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

const AGENT_URL = process.env.AGENT_URL || "http://go-ai-file-agent:18082";
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || "/data/workspaces";
const ARTIFACTS_ROOT = process.env.ARTIFACTS_ROOT || "/data/artifacts";

function loadRegistry(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(path.join(ARTIFACTS_ROOT, "manifest.json"), "utf8"));
  } catch {
    return {};
  }
}
function saveRegistry(r: Record<string, any>) {
  try {
    fs.mkdirSync(ARTIFACTS_ROOT, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS_ROOT, "manifest.json"), JSON.stringify(r));
  } catch {}
}

async function describeImage(filePath: string): Promise<string> {
  const key = process.env.OPENCODE_GO_API_KEY;
  if (!key) return "";
  const ext = path.extname(filePath).toLowerCase();
  const media = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/png";
  const data = fs.readFileSync(filePath).toString("base64");
  return describeImageBase64(`data:${media};base64,${data}`, key);
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
  const ws = path.join(WORKSPACES_ROOT, conv, job);

  // Vision: 扫描 workspace 中的图片 → MiniMax 描述 → 写入 .go-ai/vision/
  let visionMd = false;
  try {
    if (fs.existsSync(ws)) {
      for (const f of fs.readdirSync(ws)) {
        if (/\.(png|jpe?g|gif|webp)$/i.test(f)) {
          const desc = await describeImage(path.join(ws, f));
          if (desc) {
            const vDir = path.join(ws, ".go-ai", "vision");
            fs.mkdirSync(vDir, { recursive: true });
            const base = path.basename(f, path.extname(f));
            fs.writeFileSync(path.join(vDir, base + ".md"), desc);
            visionMd = true;
          }
        }
      }
    }
  } catch {}

  const task = {
    conversationId: conv,
    jobId: job,
    prompt: String(body.prompt).slice(0, 8000),
    maxTurns: Number(body.maxTurns) || 15,
    model: "deepseek-v4-flash",
    gatewayBaseUrl: "http://cc-auth-gateway:18081",
    gatewayToken: "placeholder-token",
    visionMd,
    memory: Array.isArray(body.memory) ? body.memory.map(String).slice(0, 20) : [],
    style: body.style ? String(body.style).slice(0, 500) : "",
    skills: Array.isArray(body.skills) ? body.skills.map(String).slice(0, 20) : [],
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${AGENT_URL}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(task),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "文件处理服务不可用" }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json({ error: text || `文件处理失败(${upstream.status})` }, { status: upstream.status });
  }

  const registry = loadRegistry();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const enc = (s: string) => controller.enqueue(new TextEncoder().encode(s));
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            let ev: any;
            try {
              ev = JSON.parse(t);
            } catch {
              enc(t + "\n");
              continue;
            }
            if (ev.type === "artifacts" && Array.isArray(ev.files)) {
              const ids: { id: string; name: string; mime: string; size: number }[] = [];
              for (const f of ev.files) {
                const src = path.join(ws, String(f.name || ""));
                if (!src.startsWith(ws + path.sep) || !fs.existsSync(src)) continue;
                const aid = randomUUID();
                try {
                  fs.mkdirSync(ARTIFACTS_ROOT, { recursive: true });
                  fs.copyFileSync(src, path.join(ARTIFACTS_ROOT, aid));
                  registry[aid] = { name: f.name, mime: f.mime || "application/octet-stream", size: Number(f.size) || 0, createdAt: Date.now() };
                  ids.push({ id: aid, name: f.name, mime: f.mime || "application/octet-stream", size: Number(f.size) || 0 });
                } catch {}
              }
              saveRegistry(registry);
              enc(JSON.stringify({ type: "artifacts", files: ids }) + "\n");
            } else {
              enc(t + "\n");
            }
          }
        }
        controller.close();
      } catch {
        controller.error("agent stream failed");
      }
    },
    cancel() {
      try {
        upstream.body?.cancel();
      } catch {}
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform" },
  });
}
