/** FailureTaxonomy + RepairPolicyEngine 测试（V1.2 WP22-23）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, failureLayerLabel } from "../../lib/policy/failureTaxonomy";
import { planRepair, repairActionFor } from "../../lib/policy/repairPolicy";

/* ---------- WP22 FailureTaxonomy ---------- */

test("截断错误 → MODEL_REASONING_TRUNCATED（模型层、可修复）", () => {
  const c = classifyFailure("reasoning truncated (stop=length), no final answer");
  assert.equal(c.code, "MODEL_REASONING_TRUNCATED");
  assert.equal(c.layer, "model");
  assert.equal(c.retryable, true);
});

test("无产物 → ARTIFACT_MISSING（产物层、可修复）", () => {
  const c = classifyFailure("TASK_CONTRACT_RETRYABLE：缺少预期产物：*；产物总数不足（0 < 1）");
  assert.equal(c.code, "ARTIFACT_MISSING");
  assert.equal(c.layer, "artifact");
  assert.equal(c.retryable, true);
});

test("runtime 不可用 → RUNTIME_START_FAILED；超时 → RUNTIME_TIMEOUT", () => {
  assert.equal(classifyFailure("DEV_RUNTIME_UNAVAILABLE：file-agent 容器不可达").code, "RUNTIME_START_FAILED");
  assert.equal(classifyFailure("sandbox_timeout").code, "RUNTIME_TIMEOUT");
});

test("格式失败 → ARTIFACT_INVALID；视觉失败 → VISION_FAILED", () => {
  assert.equal(classifyFailure("产物格式验证失败（2 项）").code, "ARTIFACT_INVALID");
  assert.equal(classifyFailure("视觉分析 2 张失败").code, "VISION_FAILED");
});

test("工作区安全失败 → WORKSPACE_FAILED（不可修复）", () => {
  const c = classifyFailure("WorkspaceError: path_traversal");
  assert.equal(c.code, "WORKSPACE_FAILED");
  assert.equal(c.retryable, false);
});

test("未知错误 → UNKNOWN（不盲重试）", () => {
  const c = classifyFailure("some weird internal error");
  assert.equal(c.code, "UNKNOWN");
  assert.equal(c.retryable, false);
  assert.equal(failureLayerLabel(c.layer), "未知层");
});

test("取消 → TASK_CANCELLED", () => {
  assert.equal(classifyFailure("TASK_ABORTED").code, "TASK_CANCELLED");
});

/* ---------- WP23 RepairPolicyEngine ---------- */

test("截断 → budget_upgrade（一次；已用则 none）", () => {
  const input = { attempts: 1, maxAttempts: 3 };
  assert.equal(repairActionFor("MODEL_REASONING_TRUNCATED", input).action, "budget_upgrade");
  assert.equal(repairActionFor("MODEL_REASONING_TRUNCATED", { ...input, budgetUpgradeUsed: true }).action, "none");
});

test("缺产物 → repair_instruction；格式失败 → validator_feedback；vision → vision_retry", () => {
  const input = { attempts: 1, maxAttempts: 3 };
  assert.equal(repairActionFor("ARTIFACT_MISSING", input).action, "repair_instruction");
  assert.equal(repairActionFor("ARTIFACT_INVALID", input).action, "validator_feedback");
  assert.equal(repairActionFor("VISION_FAILED", input).action, "vision_retry");
});

test("runtime 失败 → runtime_fallback；模型不可用 → none（需 fallback graph 而非盲重试）", () => {
  const input = { attempts: 1, maxAttempts: 3 };
  assert.equal(repairActionFor("RUNTIME_START_FAILED", input).action, "runtime_fallback");
  assert.equal(repairActionFor("MODEL_UNAVAILABLE", input).action, "none");
  assert.equal(repairActionFor("MODEL_REGION_UNAVAILABLE", input).action, "none");
});

test("尝试耗尽 → none（防无限）", () => {
  assert.equal(repairActionFor("ARTIFACT_MISSING", { attempts: 3, maxAttempts: 3 }).action, "none");
  assert.equal(repairActionFor("RUNTIME_TIMEOUT", { attempts: 3, maxAttempts: 3 }).action, "none");
});

test("planRepair：错误对象 → 分类 + 动作", () => {
  const { classification, repair } = planRepair({ error: new Error("TASK_CONTRACT_RETRYABLE：缺少预期产物"), attempts: 1, maxAttempts: 2 });
  assert.equal(classification.code, "ARTIFACT_MISSING");
  assert.equal(repair.action, "repair_instruction");
});
