/** ResourcePolicy 测试（V1.3 WP28）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadResourcePolicy, checkSteps, checkToolCalls, checkArtifactSize, checkConcurrentCapacity } from "../lib/policy/resourcePolicy";

test("默认策略：并发 2 / 沙盒 2 / 内存 512MB / 步骤 12 / 工具 200", () => {
  const policy = loadResourcePolicy({});
  assert.equal(policy.maxConcurrentJobs, 2);
  assert.equal(policy.maxSandboxes, 2);
  assert.equal(policy.perSandboxMemoryMb, 512);
  assert.equal(policy.maxSteps, 12);
  assert.equal(policy.maxToolCalls, 200);
});

test("环境变量覆盖", () => {
  const policy = loadResourcePolicy({ RESOURCE_MAX_CONCURRENT_JOBS: "1", RESOURCE_MAX_STEPS: "5", RESOURCE_SANDBOX_MEMORY_MB: "256" });
  assert.equal(policy.maxConcurrentJobs, 1);
  assert.equal(policy.maxSteps, 5);
  assert.equal(policy.perSandboxMemoryMb, 256);
});

test("步骤数超限被拒（防止无限步骤任务）", () => {
  const policy = loadResourcePolicy({});
  assert.equal(checkSteps(5, policy).ok, true);
  assert.equal(checkSteps(13, policy).ok, false);
  assert.match(checkSteps(20, policy).reason || "", /步骤数超限/);
});

test("工具调用超限被拒（防 runaway loop）", () => {
  const policy = loadResourcePolicy({});
  assert.equal(checkToolCalls(199, policy).ok, true);
  assert.equal(checkToolCalls(201, policy).ok, false);
});

test("产物大小超限被拒", () => {
  const policy = loadResourcePolicy({});
  assert.equal(checkArtifactSize(49 * 1024 * 1024, policy).ok, true);
  assert.equal(checkArtifactSize(51 * 1024 * 1024, policy).ok, false);
});

test("并发容量：达到上限不领取（任务保持 queued）", () => {
  const policy = loadResourcePolicy({});
  assert.equal(checkConcurrentCapacity(1, policy).ok, true);
  assert.equal(checkConcurrentCapacity(2, policy).ok, false);
  assert.match(checkConcurrentCapacity(3, policy).reason || "", /并发任务已达上限/);
});
