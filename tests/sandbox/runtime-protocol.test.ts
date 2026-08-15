/** RuntimeToolProtocol 测试（V1.3 WP7）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SandboxManager } from "../../lib/sandbox/manager";
import { LocalSandboxProvider } from "../../lib/sandbox/localProvider";
import {
  execResultToToolResult, sandboxManagerExecutor, sandboxEventToToolResult,
  toolError, resultToError,
} from "../../lib/sandbox/runtimeProtocol";

test("execResult → ToolResult（成功/失败/超时）", () => {
  const ok = execResultToToolResult("t1", { ok: true, exitCode: 0, stdout: "out", stderr: "", durationMs: 10, timedOut: false });
  assert.equal(ok.status, "success");
  assert.equal(ok.stdout, "out");

  const fail = execResultToToolResult("t2", { ok: false, exitCode: 2, stdout: "", stderr: "boom", durationMs: 5, timedOut: false });
  assert.equal(fail.status, "error");
  assert.equal(fail.stderr, "boom");

  const timed = execResultToToolResult("t3", { ok: false, exitCode: 137, stdout: "", stderr: "", durationMs: 2000, timedOut: true });
  assert.equal(timed.status, "error");
});

test("SandboxRunEvent → ToolResult 映射", () => {
  assert.equal(sandboxEventToToolResult({ type: "tool", name: "Read" }), null);
  const result = sandboxEventToToolResult({ type: "result", result: "ok" });
  assert.equal(result?.status, "success");
  const done = sandboxEventToToolResult({ type: "done", exitCode: 1 });
  assert.equal(done?.status, "error");
  const err = sandboxEventToToolResult({ type: "error", message: "x" });
  assert.equal(err?.stderr, "x");
});

test("ToolError 构造与转换", () => {
  const e = toolError("id", "TOOL_TIMEOUT", "超时", true);
  assert.equal(e.retryable, true);
  const converted = resultToError({ id: "id", status: "error", stderr: "fail" });
  assert.equal(converted.code, "TOOL_RESULT_ERROR");
});

test("sandboxManagerExecutor：文件/命令工具在沙盒内执行（真实 local provider）", async () => {
  const ws = path.join(os.tmpdir(), `goai-protocol-${Date.now()}`);
  fs.mkdirSync(ws, { recursive: true });
  const manager = new SandboxManager(new LocalSandboxProvider());
  const sbx = "protocol-test";
  await manager.allocate(sbx, ws);

  const executor = sandboxManagerExecutor({
    sandboxId: sbx,
    workspaceRoot: ws,
    manager,
    allowedNames: ["filesystem.read", "filesystem.write", "filesystem.list", "code.node.exec"],
  });

  const write = await executor.executeTool({ id: "w1", name: "filesystem.write", arguments: { path: "working/a.txt", content: "内容" } });
  assert.equal(write.status, "success");
  assert.deepEqual(write.filesChanged, ["working/a.txt"]);

  const read = await executor.executeTool({ id: "r1", name: "filesystem.read", arguments: { path: "working/a.txt" } });
  assert.equal(read.status, "success");
  assert.equal((read.data as { content?: string }).content, "内容");

  const list = await executor.executeTool({ id: "l1", name: "filesystem.list", arguments: { dir: "working" } });
  assert.equal(list.status, "success");
  assert.ok((list.data as { files?: Array<{ path: string }> }).files?.some((f) => f.path.endsWith("a.txt")));

  const exec = await executor.executeTool({ id: "e1", name: "code.node.exec", arguments: { code: "console.log('ran')" } });
  assert.equal(exec.status, "success");
  assert.match(exec.stdout || "", /ran/);

  const denied = await executor.executeTool({ id: "d1", name: "shell.exec", arguments: { command: "id" } });
  assert.equal(denied.status, "error", "未授权工具应被拒绝");
});
