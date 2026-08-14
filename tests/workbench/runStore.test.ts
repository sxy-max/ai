import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunStore } from "../../lib/workbench/runStore";

test("run store persists records and latest returns newest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "go-ai-runs-"));
  const store = new RunStore(root);
  const first = await store.save({ projectId: "p1", task: "先改背景", finalStatus: "failed", reason: "TEST_FAILED", outputs: [] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await store.save({ projectId: "p1", task: "再改黑色", finalStatus: "completed", outputs: [{ path: "outputs/index.html", size: 194, isDir: false }] });
  const latest = await store.latest("p1");
  assert.equal(latest?.id, second.id);
  assert.equal(latest?.task, "再改黑色");
  assert.equal(latest?.finalStatus, "completed");
  assert.equal(latest?.outputs[0].path, "outputs/index.html");
  assert.equal(await store.latest("missing"), null);
  await fs.rm(root, { recursive: true, force: true });
});

test("run ids and project ids reject traversal, corrupt records fail closed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "go-ai-runs-"));
  const store = new RunStore(root);
  await assert.rejects(() => store.save({ projectId: "../bad", task: "t", finalStatus: "completed", outputs: [] }), /INVALID_PROJECT_ID/);
  await fs.mkdir(path.join(root, "runs", "p1"), { recursive: true });
  await fs.writeFile(path.join(root, "runs", "p1", "bad.json"), "{}", "utf8");
  assert.equal(await store.latest("p1"), null);
  await fs.rm(root, { recursive: true, force: true });
});
