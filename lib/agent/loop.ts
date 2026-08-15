/**
 * AgentLoop（V1.2 WP10）：统一 Agent 生命周期。
 * 状态机：plan → act → observe → validate → repair → finish。
 * 统一事件（11 种）：agent_started / step_started / tool_called / tool_result /
 *   file_changed / artifact_created / validation_failed / repair_started /
 *   step_completed / agent_completed / agent_failed。
 * 不同 Runtime（Claude Code / AgentScope）都映射到这一事件模型；UI 只认识 AgentEvent。
 */

export type AgentLoopPhase = "plan" | "act" | "observe" | "validate" | "repair" | "finish";

export type AgentEvent =
  | { type: "agent_started"; runtime: string; model?: string }
  | { type: "step_started"; step: string }
  | { type: "tool_called"; name: string; detail?: string }
  | { type: "tool_result"; name: string; ok: boolean; output?: string }
  | { type: "file_changed"; path: string; bytes?: number }
  | { type: "artifact_created"; name: string; downloadUrl?: string }
  | { type: "validation_failed"; reason: string; missing?: string[] }
  | { type: "repair_started"; attempt: number; maxAttempts: number }
  | { type: "step_completed"; step: string; summary?: string }
  | { type: "agent_completed"; summary: string; artifactCount: number }
  | { type: "agent_failed"; error: string; code?: string };

export type AgentLoopState = {
  phase: AgentLoopPhase;
  attempt: number;
  maxAttempts: number;
  lastEvent?: AgentEvent;
};

export const INITIAL_LOOP: AgentLoopState = { phase: "plan", attempt: 0, maxAttempts: 2 };

/** 纯状态推进：事件 → 下一阶段（repair 循环 bounded）。 */
export function advanceLoop(state: AgentLoopState, event: AgentEvent): AgentLoopState {
  switch (event.type) {
    case "agent_started":
      return { ...state, phase: "act", attempt: 1, lastEvent: event };
    case "tool_called":
      return { ...state, phase: "act", lastEvent: event };
    case "tool_result":
      return { ...state, phase: "observe", lastEvent: event };
    case "validation_failed":
      // 进入 repair：还有尝试次数则 repair，否则留给 agent_failed
      return { ...state, phase: state.attempt < state.maxAttempts ? "repair" : "finish", lastEvent: event };
    case "repair_started":
      return { ...state, phase: "act", attempt: event.attempt, lastEvent: event };
    case "artifact_created":
      return { ...state, phase: "observe", lastEvent: event };
    case "agent_completed":
      return { ...state, phase: "finish", lastEvent: event };
    case "agent_failed":
      return { ...state, phase: "finish", lastEvent: event };
    case "step_started":
      return { ...state, phase: "plan", lastEvent: event };
    case "file_changed":
      return { ...state, phase: "observe", lastEvent: event };
    case "step_completed":
      return { ...state, phase: "act", lastEvent: event };
    default:
      return { ...state, lastEvent: event };
  }
}

/** SandboxRunEvent → AgentEvent（Runtime 私有事件归一；非 1:1 的由上层补充）。 */
export function fromSandboxEvent(
  event: { type: string; name?: string; detail?: string; text?: string; result?: string; message?: string; exitCode?: number },
  runtime: string
): AgentEvent | null {
  switch (event.type) {
    case "tool":
      return { type: "tool_called", name: String(event.name || "tool"), detail: event.detail };
    case "text":
      return null; // 文本流不产生 AgentEvent（上层转进度文本）
    case "result":
      return { type: "tool_result", name: "agent", ok: true, output: String(event.result || "") };
    case "done":
      return event.exitCode === 0
        ? { type: "step_completed", step: "runtime", summary: `退出码 ${event.exitCode}` }
        : { type: "agent_failed", error: `runtime exit ${event.exitCode}`, code: "RUNTIME_EXIT_NONZERO" };
    case "error":
      return { type: "agent_failed", error: String(event.message || "runtime error"), code: "RUNTIME_ERROR" };
    default:
      return null;
  }
}
