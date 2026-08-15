/** Capability Model + TokenBudgetManager + ReasoningExecutionState 测试（V1.2 WP2/WP5/WP6）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capabilitiesForModel,
  modelHasCapability,
  runtimeCapabilities,
  runtimeHasCapability,
  requirementsFromPlan,
} from "../../lib/policy/capabilities";
import {
  budgetFor,
  nextTierAfterTruncation,
  tierConfig,
  traceOf,
  type BudgetTier,
} from "../../lib/policy/tokenBudget";
import { deriveReasoningState, nextActionAfterReasoning, reasoningStateLabel } from "../../lib/policy/reasoningState";

/* ---------- WP2 Capability Model ---------- */

test("deepseek-v4-pro：高推理 + 无视觉", () => {
  const caps = capabilitiesForModel("deepseek-v4-pro");
  assert.equal(caps.reasoning, "high");
  assert.equal(modelHasCapability("deepseek-v4-pro", "text_generation"), true);
  assert.equal(modelHasCapability("deepseek-v4-pro", "vision"), false);
});

test("deepseek-v4-flash：工具执行强、推理中等", () => {
  const caps = capabilitiesForModel("deepseek-v4-flash");
  assert.equal(caps.reasoning, "medium");
  assert.equal(modelHasCapability("deepseek-v4-flash", "tool_execution"), true);
  assert.equal(modelHasCapability("deepseek-v4-flash", "multi_step_agent"), true);
});

test("minimax-m3：视觉专用", () => {
  assert.equal(modelHasCapability("minimax-m3", "vision"), true);
  assert.equal(modelHasCapability("minimax-m3", "visual_understanding"), true);
  assert.equal(modelHasCapability("minimax-m3", "shell"), false);
});

test("未知模型：仅基础文本能力，不假设高级能力", () => {
  const caps = capabilitiesForModel("some-unknown-model-xyz");
  assert.equal(caps.reasoning, "low");
  assert.equal(modelHasCapability("some-unknown-model-xyz", "text_generation"), true);
  assert.equal(modelHasCapability("some-unknown-model-xyz", "vision"), false);
  assert.equal(modelHasCapability("some-unknown-model-xyz", "tool_execution"), false);
});

test("runtime 能力：claude-code 有 shell/code；agentscope 有 state/event_stream/shell（V1.2 实测内置 Bash/PowerShell）；deterministic 只有生成类", () => {
  assert.equal(runtimeHasCapability("claude-code", "shell"), true);
  assert.equal(runtimeHasCapability("claude-code", "code_execution"), true);
  assert.equal(runtimeHasCapability("agentscope", "state"), true);
  assert.equal(runtimeHasCapability("agentscope", "event_stream"), true);
  assert.equal(runtimeHasCapability("agentscope", "shell"), true, "AgentScope 内置 Bash/PowerShell 工具（WP8 实测）");
  assert.equal(runtimeHasCapability("deterministic", "presentation_generation"), true);
  assert.equal(runtimeHasCapability("deterministic", "multi_step_agent"), false);
});

test("requirementsFromPlan：归一任务需求", () => {
  const req = requirementsFromPlan({
    taskType: "vision_file_transform",
    needsVision: true,
    needsWorkspace: true,
    expectedArtifacts: ["file"],
    capabilities: ["agent", "workspace", "claude-code", "vision"],
  });
  assert.equal(req.visionNeeded, true);
  assert.equal(req.workspaceNeeded, true);
  assert.ok(req.requiredCapabilities.includes("vision"));
});

/* ---------- WP5 TokenBudgetManager ---------- */

test("预算档位：工具循环每 step 限预算（tool_loop）", () => {
  const decision = budgetFor({ model: "deepseek-v4-flash", taskType: "workspace_agent", reasoningMode: "auto", inToolLoop: true });
  assert.equal(decision.tier, "tool_loop");
  assert.equal(decision.maxOutputTokens, tierConfig("tool_loop").maxOutputTokens);
  assert.equal(decision.maxOutputTokens, 2048, "工具循环不一次给巨大预算");
});

test("预算档位：高推理 → deep_reasoning", () => {
  const decision = budgetFor({ model: "deepseek-v4-pro", taskType: "chat", reasoningMode: "high" });
  assert.equal(decision.tier, "deep_reasoning");
  assert.equal(decision.maxOutputTokens, 8192);
  assert.equal(decision.reasoningHint, "high");
});

test("预算档位：产物规划（PPT）→ artifact_planning", () => {
  const decision = budgetFor({ model: "deepseek-v4-pro", taskType: "artifact_generation", reasoningMode: "auto", artifactKind: "pptx" });
  assert.equal(decision.tier, "artifact_planning");
  assert.equal(decision.maxOutputTokens, 8192);
});

test("预算档位：普通任务首轮 tiny（廉价路径）", () => {
  const decision = budgetFor({ model: "deepseek-v4-flash", taskType: "chat", reasoningMode: "auto", attemptNumber: 0 });
  assert.equal(decision.tier, "tiny");
  assert.equal(decision.maxOutputTokens, 512);
});

test("截断升级链：tiny→normal→reasoning→deep_reasoning，按档不乘 10", () => {
  const evidence = { stopReason: "length", finalEmpty: true, reasoningNonEmpty: true, alreadyRetried: false };
  const step1 = nextTierAfterTruncation("tiny", evidence);
  assert.equal(step1.upgrade, true);
  assert.equal(step1.next?.tier, "normal");
  assert.equal(step1.next?.maxOutputTokens, 2048);

  const step2 = nextTierAfterTruncation("normal", evidence);
  assert.equal(step2.next?.tier, "reasoning");

  const step3 = nextTierAfterTruncation("reasoning", evidence);
  assert.equal(step3.next?.tier, "deep_reasoning");

  // 上限保护：deep_reasoning 不再升级（不无限涨预算）
  const cap = nextTierAfterTruncation("deep_reasoning", evidence);
  assert.equal(cap.upgrade, false);
  assert.equal(cap.reason, "tier_at_cap");
});

test("截断升级判定：非截断/无推理证据/已重试 → 不升级", () => {
  const base = { stopReason: "length", finalEmpty: true, reasoningNonEmpty: true, alreadyRetried: false };
  assert.equal(nextTierAfterTruncation("tiny", { ...base, stopReason: "stop" }).upgrade, false);
  assert.equal(nextTierAfterTruncation("tiny", { ...base, finalEmpty: false }).upgrade, false);
  assert.equal(nextTierAfterTruncation("tiny", { ...base, reasoningNonEmpty: false }).upgrade, false);
  assert.equal(nextTierAfterTruncation("tiny", { ...base, alreadyRetried: true }).upgrade, false);
  // max_tokens 变体同样触发
  assert.equal(nextTierAfterTruncation("tiny", { ...base, stopReason: "max_tokens" }).upgrade, true);
});

test("traceOf：记录 initial/retry 预算轨迹", () => {
  const trace = traceOf(
    { tier: "tiny", maxOutputTokens: 512 },
    { decision: { tier: "normal", maxOutputTokens: 2048 }, evidence: { stopReason: "length", finalEmpty: true, reasoningNonEmpty: true, alreadyRetried: false } }
  );
  assert.deepEqual(trace, { initialTier: "tiny", initialBudget: 512, retryTier: "normal", retryBudget: 2048, stopReason: "length" });
});

/* ---------- WP6 ReasoningExecutionState ---------- */

test("有 final → completed（UI 才允许显示已完成）", () => {
  assert.equal(deriveReasoningState({ text: "回答", reasoning: "推理", stopReason: "stop" }), "completed");
  assert.equal(deriveReasoningState({ text: "", reasoning: "推理", stopReason: "length", hasArtifact: true }), "completed");
});

test("stop=length + 只有推理 → truncated_reasoning（不是已完成）", () => {
  const state = deriveReasoningState({ text: "", reasoning: "很长", stopReason: "length" });
  assert.equal(state, "truncated_reasoning");
  assert.equal(reasoningStateLabel(state), "推理达到本轮预算，正在继续");
});

test("正在推理（未终止）→ reasoning_streaming", () => {
  assert.equal(deriveReasoningState({ text: "", reasoning: "推理中", stopReason: undefined }), "reasoning_streaming");
  assert.equal(reasoningStateLabel("reasoning_streaming"), "推理中");
});

test("截断 → budget_upgrade_retry（一次）；completed → finalize；不无限重试", () => {
  const truncated = nextActionAfterReasoning({ text: "", reasoning: "推理", stopReason: "length" }, false);
  assert.equal(truncated.action, "budget_upgrade_retry");
  const truncatedRetried = nextActionAfterReasoning({ text: "", reasoning: "推理", stopReason: "length" }, true);
  assert.equal(truncatedRetried.action, "none", "已重试过不再升级");
  const done = nextActionAfterReasoning({ text: "最终回答", reasoning: "推理", stopReason: "stop" }, false);
  assert.equal(done.action, "finalize");
});
