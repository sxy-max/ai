/**
 * GoFileAgentAdapter：SandboxRuntimeAdapter 的第一版实现。
 * 封装 go-ai-file-agent 容器契约（POST /task → NDJSON 事件流），
 * 把原始事件归一化为 SandboxRunEvent，统一超时 / 错误分类。
 */

import type { SandboxRunEvent, SandboxRuntimeAdapter, SandboxRunRequest, SandboxRunResult } from "./adapter";

const DEFAULT_AGENT_URL = "http://go-ai-file-agent:18082";
const DEFAULT_GATEWAY_URL = "http://cc-auth-gateway:18081";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export type GoFileAgentOptions = {
  agentUrl?: string;
  gatewayBaseUrl?: string;
  gatewayToken?: string;
  defaultModel?: string;
  timeoutMs?: number;
};

type RawContainerEvent = {
  type: string;
  name?: unknown;
  detail?: unknown;
  text?: unknown;
  result?: unknown;
  files?: unknown;
  exitCode?: unknown;
  message?: unknown;
};

export class GoFileAgentAdapter implements SandboxRuntimeAdapter {
  private readonly agentUrl: string;
  private readonly gatewayBaseUrl: string;
  private readonly gatewayToken: string;
  private readonly defaultModel: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: GoFileAgentOptions = {}) {
    this.agentUrl = options.agentUrl || process.env.AGENT_URL || DEFAULT_AGENT_URL;
    this.gatewayBaseUrl = options.gatewayBaseUrl || process.env.AGENT_GATEWAY_URL || DEFAULT_GATEWAY_URL;
    this.gatewayToken = options.gatewayToken || process.env.AGENT_GATEWAY_TOKEN || "placeholder-token";
    this.defaultModel = options.defaultModel || process.env.AGENT_MODEL || "deepseek-v4-flash";
    this.defaultTimeoutMs = options.timeoutMs ?? (Number(process.env.AGENT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  }

  async run(request: SandboxRunRequest, onEvent: (event: SandboxRunEvent) => void): Promise<SandboxRunResult> {
    const started = Date.now();
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const payload = {
      conversationId: request.job.conversationId,
      jobId: request.job.jobId,
      prompt: request.prompt,
      maxTurns: request.maxTurns ?? 15,
      model: request.model ?? this.defaultModel,
      gatewayBaseUrl: this.gatewayBaseUrl,
      gatewayToken: this.gatewayToken,
      visionMd: request.visionMd ?? false,
      memory: request.memory ?? [],
      style: request.style ?? "",
      skills: request.skills ?? [],
    };

    let upstream: Response;
    try {
      upstream = await fetch(`${this.agentUrl}/task`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        onEvent({ type: "error", message: "沙箱执行超时" });
        return { ok: false, error: "sandbox_timeout", partial: false };
      }
      return this.fail(onEvent, "sandbox_unavailable", started);
    }
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      return this.fail(onEvent, detail ? `sandbox_http_${upstream.status}: ${detail.slice(0, 200)}` : `sandbox_http_${upstream.status}`, started);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let exitCode: number | undefined;
    let sawDone = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let raw: RawContainerEvent;
          try {
            raw = JSON.parse(trimmed) as RawContainerEvent;
          } catch {
            continue;
          }
          if (raw.type === "agent_tool") {
            await onEvent({ type: "tool", name: String(raw.name || "tool"), ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}) });
          } else if (raw.type === "agent_text") {
            await onEvent({ type: "text", text: String(raw.text || "") });
          } else if (raw.type === "agent_result") {
            await onEvent({ type: "result", result: String(raw.result || "") });
          } else if (raw.type === "artifacts" && Array.isArray(raw.files)) {
            await onEvent({ type: "artifacts", files: (raw.files as unknown[]).map((f) => ({ name: String((f as { name?: unknown })?.name || "download") })) });
          } else if (raw.type === "done") {
            sawDone = true;
            exitCode = typeof raw.exitCode === "number" ? raw.exitCode : undefined;
            await onEvent({ type: "done", ...(exitCode !== undefined ? { exitCode } : {}), durationMs: Date.now() - started });
          } else if (raw.type === "agent_error") {
            await onEvent({ type: "error", message: String(raw.message || "agent error") });
          }
        }
      }
    } catch (error) {
      if (isTimeoutError(error)) {
        onEvent({ type: "error", message: "沙箱执行超时" });
        return { ok: false, error: "sandbox_timeout", partial: false };
      }
      return this.fail(onEvent, "sandbox_stream_interrupted", started);
    }

    if (!sawDone) {
      return this.fail(onEvent, "sandbox_stream_ended_prematurely", started);
    }
    return { ok: true, exitCode, durationMs: Date.now() - started, partial: exitCode !== undefined && exitCode !== 0 };
  }

  private fail(onEvent: (event: SandboxRunEvent) => void, error: string, started: number): SandboxRunResult {
    onEvent({ type: "error", message: error });
    return { ok: false, error, partial: false };
  }
}

function isTimeoutError(error: unknown): boolean {
  return Boolean(error) && (error as { name?: string })?.name === "TimeoutError" || (error as { name?: string })?.name === "AbortError";
}
