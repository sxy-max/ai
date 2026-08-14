import type { AgentScopeNativeEvent, WorkbenchEvent } from "./types";

function textOf(event: AgentScopeNativeEvent) {
  return typeof event.delta === "string" ? event.delta : typeof event.text === "string" ? event.text : "";
}

export function mapAgentScopeEvent(event: AgentScopeNativeEvent): WorkbenchEvent | null {
  switch (event.type) {
    case "REPLY_START":
      return { kind: "status", status: "running" };
    case "TEXT_BLOCK_DELTA":
      return { kind: "text", text: textOf(event) };
    case "TOOL_CALL_START":
      return {
        kind: "tool_start",
        name: typeof event.tool_call_name === "string" ? event.tool_call_name : "tool",
        callId: typeof event.tool_call_id === "string" ? event.tool_call_id : undefined
      };
    case "TOOL_RESULT_END": {
      return {
        kind: "tool_result",
        name: typeof event.tool_call_name === "string" ? event.tool_call_name : "tool",
        callId: typeof event.tool_call_id === "string" ? event.tool_call_id : undefined,
        ok: event.state === "success",
        output: textOf(event) || undefined
      };
    }
    case "REPLY_END":
      if (event.finished_reason === "completed" && event.error == null) return { kind: "candidate_complete" };
      return { kind: "error", code: "RUN_FAILED", message: "Agent run did not complete" };
    default:
      return null;
  }
}

export function createAgentScopeEventMapper() {
  const toolNames = new Map<string, string>();
  const toolArguments = new Map<string, string>();
  const toolOutput = new Map<string, string>();
  return (event: AgentScopeNativeEvent): WorkbenchEvent | null => {
    if (event.type === "TOOL_CALL_START" && typeof event.tool_call_id === "string") {
      toolNames.set(event.tool_call_id, typeof event.tool_call_name === "string" ? event.tool_call_name : "tool");
    }
    if (event.type === "TOOL_CALL_DELTA" && typeof event.tool_call_id === "string") {
      toolArguments.set(event.tool_call_id, `${toolArguments.get(event.tool_call_id) || ""}${typeof event.delta === "string" ? event.delta : ""}`);
      return null;
    }
    if (event.type === "TOOL_RESULT_START" && typeof event.tool_call_id === "string" && typeof event.tool_call_name === "string") {
      toolNames.set(event.tool_call_id, event.tool_call_name);
      return null;
    }
    if (event.type === "TOOL_RESULT_TEXT_DELTA" && typeof event.tool_call_id === "string") {
      toolOutput.set(event.tool_call_id, `${toolOutput.get(event.tool_call_id) || ""}${typeof event.delta === "string" ? event.delta : ""}`);
      return null;
    }
    if (event.type === "TOOL_RESULT_END" && typeof event.tool_call_id === "string") {
      const callId = event.tool_call_id;
      const mapped: WorkbenchEvent = {
        kind: "tool_result",
        name: `${toolNames.get(callId) || "tool"} ${toolArguments.get(callId) || ""}`.trim(),
        callId,
        ok: event.state === "success",
        output: toolOutput.get(callId) || undefined
      };
      toolNames.delete(callId);
      toolArguments.delete(callId);
      toolOutput.delete(callId);
      return mapped;
    }
    return mapAgentScopeEvent(event);
  };
}
