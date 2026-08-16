/**
 * Agent Runtime Adapter：统一"云端 Agent 执行环境"的接口（WP3）。
 * 调用方（Agent Runner / dev Worker / 路由）只依赖本接口。
 *
 * 第一实现：ClaudeCodeRuntimeAdapter（GoFileAgentAdapter，go-ai-file-agent 容器，
 * Claude Code + DeepSeek V4 Flash，线上已部署）。
 * 预留：CodexRuntimeAdapter（本轮不实现，stub 明确报错）。
 *
 * 事件契约（AgentEvent 语义，经 adapter 归一化）：
 *   tool / text / result / artifacts / done / error
 * 上层（runAgentJob / worker）再映射为业务事件（task_events / JobEvent）。
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
  /** workspace 中是否已有 vision/ 视觉上下文（容器据此决定是否读取）。 */
  visionMd?: boolean;
  timeoutMs?: number;
  /** 外部取消信号（任务取消/超时）。 */
  signal?: AbortSignal;
  /** 本 Goal：Preflight 执行指令（WHAT+CONSTRAINT+CAPABILITY，容器据此挂 MCP/工具/契约）。 */
  directive?: {
    taskType?: string;
    mainModel?: string;
    fallbackModels?: string[];
    capabilities?: string[];
    mcpServers?: string[];
    tools?: string[];
    deliveryContract?: Record<string, unknown>;
    reasoning?: string;
    profile?: string;
    workspaceMode?: string;
  };
  /** 本 Goal：Go AI Validation 失败证据回交（同一工作上下文继续修，不重开空任务）。 */
  repair?: {
    round: number;
    maxRounds: number;
    feedback: string;
    failures: Array<{ code: string; detail: string }>;
  };
  /** 是否续接上一个 Claude Code 会话（同 workspace 多轮）。 */
  continueSession?: boolean;
};

export type SandboxRunResult =
  | { ok: true; exitCode?: number; durationMs?: number; partial?: boolean }
  | { ok: false; error: string; partial?: boolean };

export type CollectedOutput = { relPath: string; absPath: string; size: number; isDir: boolean };

/** 运行时就绪检查结果。 */
export type RuntimePrepareResult = { ok: true; detail?: string } | { ok: false; error: string };

/**
 * Agent Runtime 生命周期契约（WP3）。
 * execute 是核心；prepare/collectOutputs/cancel/cleanup 为可选能力（未实现时上层按可用性降级）。
 */
export interface AgentRuntimeAdapter {
  /** 运行时标识：claude-code-file-agent | codex | ... */
  readonly id: string;
  /** 是否真正可用（false = 未配置/未部署，上层给出明确错误而非静默失败）。 */
  readonly available: boolean;
  /** 就绪检查：探测运行时可达性、凭证完整。失败时上层直接报错。 */
  prepare(): Promise<RuntimePrepareResult>;
  /** 执行一次 agent run；事件按序回调（必须 await，保证顺序）。 */
  execute(request: SandboxRunRequest, onEvent: (event: SandboxRunEvent) => void | Promise<void>): Promise<SandboxRunResult>;
  /** 兼容别名（旧实现只提供 run）。 */
  run?(request: SandboxRunRequest, onEvent: (event: SandboxRunEvent) => void | Promise<void>): Promise<SandboxRunResult>;
  /** 从 workspace 收集产物（output/ 与 artifacts/ 目录）。 */
  collectOutputs?(workspaceRoot: string): Promise<CollectedOutput[]>;
  /** 取消执行中的 run（signal 已接入时通常由上层 AbortController 完成）。 */
  cancel?(jobId: string): Promise<void>;
  /** 执行后清理（临时文件/会话）。默认 no-op。 */
  cleanup?(jobId: string): Promise<void>;
}

/** 向后兼容：旧调用方（runAgentJob）仍可按 SandboxRuntimeAdapter 使用。 */
export interface SandboxRuntimeAdapter {
  run(request: SandboxRunRequest, onEvent: (event: SandboxRunEvent) => void | Promise<void>): Promise<SandboxRunResult>;
}
