export type RunFailureReason =
  | "UPSTREAM_ERROR"
  | "RUN_INCOMPLETE"
  | "OUTPUT_NOT_FOUND"
  | "INVALID_OUTPUT"
  | "TEST_NOT_RUN"
  | "TEST_FAILED";

export type WorkbenchEvent =
  | { kind: "status"; status: "running" }
  | { kind: "text"; text: string }
  | { kind: "tool_start"; name: string; callId?: string }
  | { kind: "tool_result"; name: string; ok: boolean; callId?: string; output?: string }
  | { kind: "candidate_complete" }
  // V1.5：AgentScope 外部工具协议——agent 暂停等待 Go AI 执行工具并回投
  | { kind: "external_tool_call"; replyId: string; toolCalls: Array<{ id: string; name: string; input: string }> }
  | { kind: "error"; code: string; message: string }
  | { kind: "final"; status: "completed"; outputs: OutputEntry[] }
  | { kind: "final"; status: "failed"; reason: RunFailureReason };

export type OutputEntry = { path: string; size: number; isDir: boolean };

export type RunGateResult =
  | { status: "completed"; outputs: OutputEntry[] }
  | {
      status: "failed";
      reason: RunFailureReason;
    };
