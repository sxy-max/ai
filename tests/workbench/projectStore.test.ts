import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectStore } from "../../lib/workbench/projectStore";

test("project store persists and restores without secrets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "go-ai-projects-"));
  const store = new ProjectStore(root);
  const project = await store.create({ id: "p1", name: "Demo", agentId: "a1", sessionId: "s1" });
  assert.deepEqual(await new ProjectStore(root).get("p1"), project);
  const disk = await fs.readFile(path.join(root, "projects", "p1.json"), "utf8");
  assert.equal(/api[_-]?key|password|secret/i.test(disk), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("project ids reject traversal and corrupt records fail closed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "go-ai-projects-"));
  const store = new ProjectStore(root);
  await assert.rejects(() => store.get("../bad"), /INVALID_PROJECT_ID/);
  await fs.mkdir(path.join(root, "projects"), { recursive: true });
  await fs.writeFile(path.join(root, "projects", "bad.json"), "{}", "utf8");
  await assert.rejects(() => store.get("bad"), /CORRUPT_PROJECT_RECORD/);
  await fs.rm(root, { recursive: true, force: true });
});

