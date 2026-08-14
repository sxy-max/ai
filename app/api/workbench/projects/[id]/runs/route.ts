import { NextResponse } from "next/server";
import { accessConfigurationError, currentUser } from "../../../../../../lib/auth";
import { evaluateRun } from "../../../../../../lib/workbench/runGate";
import { taskInstruction } from "../../../../../../lib/workbench/projectService";
import { canAccessProject, getProjectOrThrow, getRuntimeClient } from "../../../../../../lib/workbench/runtime";
import { runStore } from "../../../../../../lib/workbench/runStore";
import type { OutputEntry, WorkbenchEvent } from "../../../../../../lib/workbench/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const configurationError = accessConfigurationError();
  if (configurationError) return NextResponse.json({ error: configurationError }, { status: 503 });
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const project = await getProjectOrThrow((await params).id).catch(() => null);
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  if (!canAccessProject(project, user.id)) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body.task !== "string" || !body.task.trim()) return NextResponse.json({ error: "任务不能为空" }, { status: 400 });

  const client = getRuntimeClient();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const events: WorkbenchEvent[] = [];
      const send = (event: WorkbenchEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const upstream = client.streamEvents(project.agentId, project.sessionId, request.signal);
        const connected = await upstream.next();
        if (connected.done || connected.value.kind === "error") throw new Error("AgentScope event stream unavailable");
        events.push(connected.value);
        send(connected.value);
        await client.triggerRun({
          agent_id: project.agentId,
          session_id: project.sessionId,
          input: { name: "user", role: "user", content: [{ type: "text", text: taskInstruction(body.task) }] }
        });
        let nextEvent = upstream.next();
        while (true) {
          const item = await nextEvent;
          if (item.done) break;
          const event = item.value;
          nextEvent = upstream.next();
          events.push(event);
          send(event);
          if (event.kind === "candidate_complete" || event.kind === "error") break;
        }
        let outputs: OutputEntry[] = [];
        if (events.some((event) => event.kind === "candidate_complete")) {
          const listing = await client.listDirectory(project.agentId, project.sessionId, "outputs");
          outputs = listing.entries.map((entry) => ({ path: `outputs/${entry.name}`, size: entry.size_bytes || 0, isDir: entry.is_dir }));
        }
        const result = evaluateRun({ events, outputs, requiresTests: Boolean(body.requiresTests) });
        try {
          await runStore.save({
            projectId: project.id,
            task: body.task,
            finalStatus: result.status,
            reason: result.status === "failed" ? result.reason : undefined,
            outputs: result.status === "completed" ? result.outputs : []
          });
        } catch (persistError) {
          console.error("run record persist failed", persistError);
        }
        send(result.status === "completed"
          ? { kind: "final", status: "completed", outputs: result.outputs }
          : { kind: "final", status: "failed", reason: result.reason });
      } catch (error) {
        send({ kind: "error", code: "RUN_PROXY_FAILED", message: error instanceof Error ? error.message : "任务执行失败" });
        send({ kind: "final", status: "failed", reason: "UPSTREAM_ERROR" });
      } finally {
        controller.close();
      }
    }
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" } });
}
