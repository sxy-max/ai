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

test("2. updateStatus 状态迁移 + 时间戳", () => {
  const store = new JobStore();
  store.create("job1", "c");
  const running = store.updateStatus("job1", "reading_files");
  assert.equal(running?.status, "reading_files");
  assert.ok(running?.startedAt);
  const done = store.updateStatus("job1", "done", { exitCode: 0, artifactCount: 2 });
  assert.equal(done?.status, "done");
  assert.ok(done?.finishedAt);
  assert.equal(done?.artifactCount, 2);
});

test("3. 终结后禁止迁移（updateStatus 为 no-op）", () => {
  const store = new JobStore();
  store.create("job1", "c");
  store.updateStatus("job1", "failed", { error: "boom" });
  assert.equal(store.updateStatus("job1", "editing"), null);
  assert.equal(store.get("job1")?.status, "failed");
  // done → failed 同样拒绝
  const s2 = new JobStore();
  s2.create("j2", "c");
  s2.updateStatus("j2", "done");
  assert.equal(s2.updateStatus("j2", "failed"), null);
});

test("4. 运行中阶段自由迁移；不存在的 job → 返回 null", () => {
  const store = new JobStore();
  store.create("job1", "c");
  assert.equal(store.updateStatus("job1", "editing")?.status, "editing");
  assert.equal(store.updateStatus("job1", "running_check")?.status, "running_check");
  assert.equal(store.updateStatus("nope", "editing"), null);
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
