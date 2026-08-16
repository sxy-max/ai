/** AgentScope legacy 通道类型（本 Goal：AgentScope 退出主链，保留为 legacy adapter）。 */

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AgentScopeNativeEvent = {
  type?: string;
  delta?: string;
  text?: string;
  name?: string;
  tool_call_name?: string;
  tool_call_id?: string;
  state?: "success" | "error" | "interrupted" | "denied" | "running" | string;
  finished_reason?: string;
  error?: unknown;
  [key: string]: unknown;
};

export type DirectoryEntry = {
  name: string;
  is_dir: boolean;
  size_bytes: number | null;
  updated_at?: number | null;
};

export type DirectoryListing = { path: string; entries: DirectoryEntry[] };
export type WorkspaceStatus = { workdir: string; cwd: string; git: unknown | null };

export class AgentScopeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "AgentScopeError";
  }
}

/* ---------- legacy 工作台事件（AgentScope 通道 eventMapper 使用；workbench 已退役） ---------- */

export type RunFailureReason =
  | "UPSTREAM_ERROR"
  | "RUN_INCOMPLETE"
  | "OUTPUT_NOT_FOUND"
  | "INVALID_OUTPUT"
  | "TEST_NOT_RUN"
  | "TEST_FAILED";

export type OutputEntry = { path: string; size: number; isDir: boolean };

export type WorkbenchEvent =
  | { kind: "status"; status: "running" }
  | { kind: "text"; text: string }
  | { kind: "tool_start"; name: string; callId?: string }
  | { kind: "tool_result"; name: string; ok: boolean; callId?: string; output?: string }
  | { kind: "candidate_complete" }
  | { kind: "external_tool_call"; replyId: string; toolCalls: Array<{ id: string; name: string; input: string }> }
  | { kind: "error"; code: string; message: string }
  | { kind: "final"; status: "completed"; outputs: OutputEntry[] }
  | { kind: "final"; status: "failed"; reason: RunFailureReason };
