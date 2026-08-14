import { currentUser } from "../../../../../lib/auth";
import { getTask } from "../../../../../lib/tasks/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tasks/:id/events?cursor=<lastEventId>
 * SSE 任务事件流（PRD §64）：以 PG task_events 为源做游标轮询，
 * 服务重启/页面断开都不丢事件；cursor 传客户端收到的最新事件 id。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser(request);
  if (!user) return new Response("unauthorized", { status: 401 });
  const taskId = (await params).id;
  const task = await getTask(taskId);
  if (!task || task.user_id !== user.id) return new Response("not found", { status: 404 });

  const url = new URL(request.url);
  const rawCursor = url.searchParams.get("cursor") || "0";
  // F9：非法 cursor 会导致 PG 类型错误无限循环，校验后回退
  const cursor = /^\d+$/.test(rawCursor) ? rawCursor : "0";
  const abort = request.signal;

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (data: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(data)); } catch { /* 客户端断开 */ }
      };
      send(`retry: 2000\n\n`);

      let lastId = cursor;
      const { listTaskEvents } = await import("../../../../../lib/tasks/repo");
      while (!abort.aborted && !closed) {
        try {
          const events = await listTaskEvents(taskId, lastId === "0" ? undefined : lastId, 200);
          for (const event of events) {
            send(`id: ${event.id}\nevent: task\ndata: ${JSON.stringify({ id: event.id, type: event.type, payload: event.payload, created_at: event.created_at })}\n\n`);
            lastId = event.id;
          }
          if (events.length < 200) await sleep(1200);
        } catch (error) {
          send(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : "事件流错误" })}\n\n`);
          await sleep(2000);
        }
      }
      closed = true;
      try { controller.close(); } catch {}
    },
    cancel() { closed = true; }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive"
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
