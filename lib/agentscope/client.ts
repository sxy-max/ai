import { createAgentScopeEventMapper } from "./eventMapper";
import { AgentScopeError, type AgentScopeNativeEvent, type DirectoryListing, type FetchLike, type WorkbenchEvent, type WorkspaceStatus } from "./types";

type ClientOptions = { baseUrl: string; userId: string; fetchImpl?: FetchLike };

function cleanErrorBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanErrorBody);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/api[_-]?key|authorization|secret|password/i.test(key))
      .map(([key, item]) => [key, cleanErrorBody(item)])
  );
}

export function createAgentScopeClient(options: ClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const userId = options.userId;
  const fetchImpl = options.fetchImpl || fetch;

  async function request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("X-User-ID", userId);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers, cache: "no-store" });
    if (response.ok) return response;
    const raw = await response.text();
    let body: unknown = raw;
    try { body = JSON.parse(raw); } catch { /* retain text */ }
    body = cleanErrorBody(body);
    throw new AgentScopeError(`AgentScope request failed (${response.status})`, response.status, body);
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await request(path, init)).json() as Promise<T>;
  }

  function query(values: Record<string, string>) {
    return new URLSearchParams(values).toString();
  }

  return {
    createCredential: (data: unknown) => json<{ credential_id: string }>("/credential/", { method: "POST", body: JSON.stringify({ data }) }),
    createAgent: (body: unknown) => json<{ agent_id: string }>("/agent/", { method: "POST", body: JSON.stringify(body) }),
    createSession: (body: unknown) => json<{ session_id: string }>("/sessions/", { method: "POST", body: JSON.stringify(body) }),
    setPermissionBypass: (agentId: string, sessionId: string) => json(`/sessions/${encodeURIComponent(sessionId)}?${query({ agent_id: agentId })}`, { method: "PATCH", body: JSON.stringify({ permission_mode: "bypass" }) }),
    triggerRun: (body: unknown) => json<{ status: string; session_id: string }>("/chat/", { method: "POST", body: JSON.stringify(body) }),
    interrupt: (agentId: string, sessionId: string) => json(`/sessions/${encodeURIComponent(sessionId)}/interrupt?${query({ agent_id: agentId })}`, { method: "POST" }),
    getMessages: (agentId: string, sessionId: string) => json(`/sessions/${encodeURIComponent(sessionId)}/messages?${query({ agent_id: agentId })}`),
    getSessionStatus: (agentId: string, sessionId: string) => json(`/sessions/${encodeURIComponent(sessionId)}/status?${query({ agent_id: agentId })}`),
    listDirectory: (agentId: string, sessionId: string, path: string) => json<DirectoryListing>(`/workspace/directories?${query({ agent_id: agentId, session_id: sessionId, path })}`),
    workspaceStatus: (agentId: string, sessionId: string) => json<WorkspaceStatus>(`/workspace/status?${query({ agent_id: agentId, session_id: sessionId })}`),
    readFile: (agentId: string, sessionId: string, path: string) => request(`/workspace/files?${query({ agent_id: agentId, session_id: sessionId, path, download: "true" })}`),
    async *streamEvents(agentId: string, sessionId: string, signal?: AbortSignal): AsyncGenerator<WorkbenchEvent> {
      let response: Response;
      try {
        response = await request(`/sessions/${encodeURIComponent(sessionId)}/stream?${query({ agent_id: agentId })}`, { headers: { Accept: "text/event-stream" }, signal });
      } catch (error) {
        yield { kind: "error", code: "STREAM_CONNECT_FAILED", message: error instanceof Error ? error.message : "Stream connection failed" };
        return;
      }
      if (!response.body) {
        yield { kind: "error", code: "STREAM_BODY_MISSING", message: "AgentScope stream has no body" };
        return;
      }
      // This first event is a connection handshake. Callers can await it
      // before firing /chat so short runs cannot outrun the SSE subscription.
      yield { kind: "status", status: "running" };
      const reader = response.body.getReader();
      const mapEvent = createAgentScopeEventMapper();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          try {
            const mapped = mapEvent(JSON.parse(data) as AgentScopeNativeEvent);
            if (mapped) yield mapped;
          } catch {
            yield { kind: "error", code: "INVALID_SSE_EVENT", message: "AgentScope returned an invalid event" };
          }
        }
        if (done) break;
      }
      if (buffer.trim()) yield { kind: "error", code: "TRUNCATED_SSE_EVENT", message: "AgentScope stream ended mid-event" };
    }
  };
}
