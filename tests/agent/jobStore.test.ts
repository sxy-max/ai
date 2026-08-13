import assert from "node:assert/strict";
import { test } from "node:test";
import { JobStore } from "../../lib/agent/jobStore";

test("1. create → queued；get / list 可读", () => {
  const store = new JobStore();
  const job = store.create("job1", "conv1");
  assert.equal(job.status, "queued");
  assert.equal(store.get("job1")?.status, "queued");
  assert.equal(store.list("conv1").length, 1);
  assert.equal(store.list("other").length, 0);
});

test("2. start / complete 状态迁移 + 时间戳", () => {
  const store = new JobStore();
  store.create("job1", "c");
  const running = store.start("job1");
  assert.equal(running?.status, "running");
  assert.ok(running?.startedAt);
  const done = store.complete("job1", { exitCode: 0, artifactCount: 2 });
  assert.equal(done?.status, "done");
  assert.ok(done?.finishedAt);
  assert.equal(done?.artifactCount, 2);
});

test("3. 终结后禁止迁移（start/complete/fail 均为 no-op）", () => {
  const store = new JobStore();
  store.create("job1", "c");
  store.fail("job1", "boom");
  assert.equal(store.start("job1"), null);
  assert.equal(store.complete("job1"), null);
  assert.equal(store.get("job1")?.status, "failed");
});

test("4. 不存在的 job → 迁移返回 null", () => {
  const store = new JobStore();
  assert.equal(store.start("nope"), null);
  assert.equal(store.complete("nope"), null);
  assert.equal(store.fail("nope", "x"), null);
});

test("5. cleanupExpired → 只删超期 job", () => {
  const store = new JobStore();
  store.create("old", "c");
  const old = store.get("old")!;
  old.createdAt = 1; // 直接篡改为过期
  store.create("fresh", "c");
  assert.equal(store.cleanupExpired(1 + 24 * 60 * 60 * 1000 + 1), 1);
  assert.equal(store.get("old"), undefined);
  assert.equal(store.get("fresh")?.status, "queued");
});
