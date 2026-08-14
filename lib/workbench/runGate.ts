import path from "node:path";
import type { OutputEntry, RunGateResult, WorkbenchEvent } from "./types";

const TEST_TOOL = /(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|typecheck)\b|(?:^|[^a-z])(?:pytest|jest|vitest|playwright\s+test|typecheck)(?:[^a-z]|$)/i;

function isValidOutput(entry: OutputEntry) {
  const normalized = entry.path.replace(/\\/g, "/");
  if (entry.isDir || !Number.isFinite(entry.size) || entry.size <= 0) return false;
  if (!normalized.startsWith("outputs/")) return false;
  if (path.posix.normalize(normalized) !== normalized) return false;
  return !normalized.split("/").includes("..");
}

export function evaluateRun(input: {
  events: WorkbenchEvent[];
  outputs: OutputEntry[];
  requiresTests?: boolean;
}): RunGateResult {
  if (input.events.some((event) => event.kind === "error")) {
    return { status: "failed", reason: "UPSTREAM_ERROR" };
  }
  if (!input.events.some((event) => event.kind === "candidate_complete")) {
    return { status: "failed", reason: "RUN_INCOMPLETE" };
  }

  if (input.outputs.some((entry) => !isValidOutput(entry))) {
    return { status: "failed", reason: "INVALID_OUTPUT" };
  }
  const outputs = input.outputs.filter(isValidOutput);
  if (!outputs.length) return { status: "failed", reason: "OUTPUT_NOT_FOUND" };

  if (input.requiresTests) {
    const testResults = input.events.filter(
      (event): event is Extract<WorkbenchEvent, { kind: "tool_result" }> =>
        event.kind === "tool_result" && TEST_TOOL.test(event.name)
    );
    if (!testResults.length) return { status: "failed", reason: "TEST_NOT_RUN" };
    if (testResults.some((event) => !event.ok)) return { status: "failed", reason: "TEST_FAILED" };
  }
  return { status: "completed", outputs };
}
