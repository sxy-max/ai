/**
 * Sandbox Runtime Adapter：统一"云端 Agent 执行环境"的接口。
 * 调用方（Agent Runner / 路由）只依赖本接口；当前唯一实现是 go-ai-file-agent
 * 容器（Claude Code + DeepSeek V4 Flash），未来可换 E2B / 独立 Sandbox Service。
 */

/** Agent 执行过程中的运行时无关事件（容器原始事件经 adapter 归一化后输出）。 */
export type SandboxRunEvent =
  | { type: "tool"; name: string; detail?: string }
  | { type: "text"; text: string }
  | { type: "result"; result: string }
  | { type: "artifacts"; files: { name: string }[] }
  | { type: "done"; exitCode?: number; durationMs?: number }
  | { type: "error"; message: string };

export type SandboxRunRequest = {
  job: { conversationId: string; jobId: string };
  prompt: string;
  maxTurns?: number;
  model?: string;
  memory?: string[];
  style?: string;
  skills?: string[];
  /** workspace 中是否已有 .go-ai/vision/ 视觉上下文（容器据此决定是否读取）。 */
  visionMd?: boolean;
  timeoutMs?: number;
};

export type SandboxRunResult =
  | { ok: true; exitCode?: number; durationMs?: number; partial?: boolean }
  | { ok: false; error: string; partial?: boolean };

export interface SandboxRuntimeAdapter {
  /** 逐个事件回调；可返回 Promise，实现方须按序 await，保证事件先后顺序。 */
  run(request: SandboxRunRequest, onEvent: (event: SandboxRunEvent) => void | Promise<void>): Promise<SandboxRunResult>;
}
