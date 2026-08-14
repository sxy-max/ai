/** WP5 测试：SandboxRuntime 抽象（DockerSandboxRuntime + 共享卷 + fake exec）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DockerSandboxRuntime } from "../../lib/sandbox/runtime";
import type { AgentRuntimeAdapter, RuntimePrepareResult, SandboxRunEvent, SandboxRunRequest, SandboxRunResult } from "../../lib/sandbox/adapter";

class FakeAdapter implements AgentRuntimeAdapter {
  readonly id = "fake";
  readonly available = true;
  executed: Array<{ prompt: string; workspaceId: string }> = [];
  result: SandboxRunResult = { ok: true, exitCode: 0 };

  async prepare(): Promise<RuntimePrepareResult> { return { ok: true }; }
  async execute(request: SandboxRunRequest, onEvent: (event: SandboxRunEvent) => void | Promise<void>): Promise<SandboxRunResult> {
    this.executed.push({ prompt: request.prompt, workspaceId: request.job.jobId });
    await onEvent({ type: "tool", name: "Read" });
    await onEvent({ type: "done", exitCode: 0 });
    return this.result;
  }
  async collectOutputs(): Promise<never[]> { return []; }
  async cancel(): Promise<void> {}
  async cleanup(): Promise<void> {}
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "goai-runtime-"));

test("SandboxRuntime：create/stageInput/exec/readFile/collectFiles 全链路", async () => {
  const adapter = new FakeAdapter();
  const runtime = new DockerSandboxRuntime(adapter, ROOT);

  const wsRoot = path.join(ROOT, "tasks", "task-1");
  const session = await runtime.create("task-1", wsRoot);

  // stageInput → input/
  const staged = await runtime.stageInput(session, [
    { relPath: "index.html", content: Buffer.from("<html>old</html>") }
  ]);
  assert.equal(staged, 1);
  const input = await runtime.readFile(session, "input/index.html");
  assert.equal(input?.toString(), "<html>old</html>");

  // exec → adapter 收到 workspaceId 与 prompt
  const events: string[] = [];
  const result = await runtime.exec(session, { prompt: "改页面", visionMd: true }, (e: SandboxRunEvent) => { events.push(e.type); });
  assert.equal(result.ok, true);
  assert.equal(adapter.executed[0].workspaceId, "task-1");
  assert.equal(adapter.executed[0].prompt, "改页面");
  assert.deepEqual(events, ["tool", "done"]);

  // writeFile + collectFiles（output/）
  await runtime.writeFile(session, "output/result.html", Buffer.from("<html>new</html>"));
  const collected = await runtime.collectFiles(session);
  assert.equal(collected.length, 1);
  assert.equal(collected[0].relPath, "output/result.html");

  // listFiles
  const files = await runtime.listFiles(session);
  assert.ok(files.some((f: { relPath: string }) => f.relPath.includes("index.html")));

  await runtime.kill(session);
  await runtime.destroy(session);
});

test("SandboxRuntime：writeFile 防路径逃逸", async () => {
  const adapter = new FakeAdapter();
  const runtime = new DockerSandboxRuntime(adapter, ROOT);
  const session = await runtime.create("task-escape", path.join(ROOT, "tasks", "task-escape"));
  await assert.rejects(runtime.writeFile(session, "../../escape.txt", Buffer.from("x")), /PATH_ESCAPE/);
});
