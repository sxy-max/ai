import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRun } from "../../lib/workbench/runGate";
import type { WorkbenchEvent } from "../../lib/workbench/types";

const candidate: WorkbenchEvent = { kind: "candidate_complete" };

test("model text never completes a task", () => {
  assert.deepEqual(evaluateRun({ events: [{ kind: "text", text: "已完成" }], outputs: [] }), {
    status: "failed", reason: "RUN_INCOMPLETE"
  });
});

test("candidate complete with no output fails", () => {
  assert.deepEqual(evaluateRun({ events: [candidate], outputs: [] }), {
    status: "failed", reason: "OUTPUT_NOT_FOUND"
  });
});

test("candidate complete with a real output succeeds", () => {
  assert.equal(evaluateRun({ events: [candidate], outputs: [{ path: "outputs/index.html", size: 42, isDir: false }] }).status, "completed");
});

test("empty, directory and traversal outputs are rejected", () => {
  for (const output of [
    { path: "outputs/empty.txt", size: 0, isDir: false },
    { path: "outputs/folder", size: 20, isDir: true },
    { path: "outputs/../input/secret", size: 20, isDir: false }
  ]) {
    assert.deepEqual(evaluateRun({ events: [candidate], outputs: [output] }), {
      status: "failed", reason: "INVALID_OUTPUT"
    });
  }
});

test("required tests must have a successful tool result", () => {
  const outputs = [{ path: "outputs/app.zip", size: 20, isDir: false }];
  assert.deepEqual(evaluateRun({ events: [candidate], outputs, requiresTests: true }), {
    status: "failed", reason: "TEST_NOT_RUN"
  });
  assert.deepEqual(evaluateRun({ events: [candidate, { kind: "tool_result", name: "npm test", ok: false }], outputs, requiresTests: true }), {
    status: "failed", reason: "TEST_FAILED"
  });
  assert.equal(evaluateRun({ events: [candidate, { kind: "tool_result", name: "npm test", ok: true }], outputs, requiresTests: true }).status, "completed");
  assert.equal(evaluateRun({ events: [candidate, { kind: "tool_result", name: 'Bash {"command":"npm test"}', ok: true }], outputs, requiresTests: true }).status, "completed");
  assert.deepEqual(evaluateRun({ events: [candidate, { kind: "tool_result", name: "npm test", ok: true }, { kind: "tool_result", name: "npm build", ok: false }], outputs, requiresTests: true }), {
    status: "failed", reason: "TEST_FAILED"
  });
});
