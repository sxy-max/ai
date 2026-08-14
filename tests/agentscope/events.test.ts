import assert from "node:assert/strict";
import test from "node:test";
import { createAgentScopeEventMapper, mapAgentScopeEvent } from "../../lib/agentscope/eventMapper";

test("only a clean completed REPLY_END becomes a candidate", () => {
  assert.deepEqual(mapAgentScopeEvent({ type: "TEXT_BLOCK_DELTA", delta: "完成了" }), { kind: "text", text: "完成了" });
  assert.deepEqual(mapAgentScopeEvent({ type: "REPLY_END", finished_reason: "completed", error: null }), { kind: "candidate_complete" });
  assert.equal(mapAgentScopeEvent({ type: "REPLY_END", finished_reason: "failed" })?.kind, "error");
});

test("tool events use the v2.0.6 tool name and state fields", () => {
  const mapEvent = createAgentScopeEventMapper();
  assert.deepEqual(mapEvent({ type: "TOOL_CALL_START", tool_call_name: "npm test", tool_call_id: "c1" }), {
    kind: "tool_start", name: "npm test", callId: "c1"
  });
  assert.equal(mapEvent({ type: "TOOL_RESULT_START", tool_call_name: "npm test", tool_call_id: "c1" }), null);
  assert.equal(mapEvent({ type: "TOOL_RESULT_TEXT_DELTA", tool_call_id: "c1", delta: "exit code 1" }), null);
  assert.deepEqual(mapEvent({ type: "TOOL_RESULT_END", tool_call_id: "c1", state: "error" }), {
    kind: "tool_result", name: "npm test", callId: "c1", ok: false, output: "exit code 1"
  });
});

test("Bash tool arguments carry the actual test command into the result", () => {
  const mapEvent = createAgentScopeEventMapper();
  mapEvent({ type: "TOOL_CALL_START", tool_call_name: "Bash", tool_call_id: "c2" });
  mapEvent({ type: "TOOL_CALL_DELTA", tool_call_id: "c2", delta: '{"command":"npm test"}' });
  assert.deepEqual(mapEvent({ type: "TOOL_RESULT_END", tool_call_id: "c2", state: "success" }), {
    kind: "tool_result", name: 'Bash {"command":"npm test"}', callId: "c2", ok: true, output: undefined
  });
});
