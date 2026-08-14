/** WP16 安全回归：跨 workspace 隔离 + 路径逃逸 + symlink + 限额。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager } from "../../lib/workspace/service";
import { DockerSandboxRuntime } from "../../lib/sandbox/runtime";
import type { AgentRuntimeAdapter, RuntimePrepareResult, SandboxRunEvent, SandboxRunRequest, SandboxRunResult } from "../../lib/sandbox/adapter";

class NoopAdapter implements AgentRuntimeAdapter {
  readonly id = "noop";
  readonly available = true;
  async prepare(): Promise<RuntimePrepareResult> { return { ok: true }; }
  async execute(_r: SandboxRunRequest, _e: (ev: SandboxRunEvent) => void | Promise<void>): Promise<SandboxRunResult> { return { ok: true, exitCode: 0 }; }
  async collectOutputs(): Promise<never[]> { return []; }
  async cancel(): Promise<void> {}
  async cleanup(): Promise<void> {}
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "goai-sec-"));

test("跨 workspace 隔离：A 的文件不能被 B 读取/写入", async () => {
  const runtime = new DockerSandboxRuntime(new NoopAdapter(), ROOT);
  const wsA = new WorkspaceManager(path.join(ROOT, "tasks", "task-a")).createWorkspace();
  wsA.writeInputFile("secret.md", "A 的机密");

  // B 尝试读 A 的文件（相对路径穿越）
  const sessionB = await runtime.create("task-b", path.join(ROOT, "tasks", "task-b"));
  const leaked = await runtime.readFile(sessionB, "../task-a/input/secret.md");
  assert.equal(leaked, null, "跨 workspace 读取必须失败");

  // 写逃逸
  await assert.rejects(runtime.writeFile(sessionB, "../../outside.txt", Buffer.from("x")), /PATH_ESCAPE|escape/i);
});

test("symlink 逃逸：workspace 内符号链接指向外部 → 读取被拒", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "goai-outside-"));
  fs.writeFileSync(path.join(outside, "target.txt"), "外部文件");
  const ws = new WorkspaceManager(path.join(ROOT, "tasks", "task-sym")).createWorkspace();
  try {
    fs.symlinkSync(path.join(outside, "target.txt"), path.join(ws.root, "working", "link.txt"));
  } catch {
    // Windows 无权限创建 symlink 时跳过
    return;
  }
  const buf = ws.readWorkspaceFile("working/link.txt");
  assert.equal(buf, null, "symlink 逃逸读取应被拒");
});

test("限额：超大文件/文件数超限被拒", () => {
  const ws = new WorkspaceManager(path.join(ROOT, "tasks", "task-limits")).createWorkspace();
  assert.throws(() => ws.writeInputFile("big.txt", Buffer.alloc(ws.limits.maxFileSize + 1)), /file_too_large/);
  const small = Buffer.from("x");
  for (let i = 0; i < ws.limits.maxFiles; i++) ws.writeInputFile(`f${i}.txt`, small);
  assert.throws(() => ws.writeInputFile("over.txt", small), /too_many_files/);
});

test("Agent timeout：exec 透传 timeoutMs 给 adapter（超时由 adapter 执行）", async () => {
  let receivedTimeout: number | undefined;
  const adapter: AgentRuntimeAdapter = {
    id: "timeout", available: true,
    async prepare() { return { ok: true }; },
    async execute(r: SandboxRunRequest, _e) { receivedTimeout = r.timeoutMs; return { ok: true, exitCode: 0 }; },
    async collectOutputs() { return []; },
    async cancel() {},
    async cleanup() {}
  };
  const runtime = new DockerSandboxRuntime(adapter, ROOT);
  const session = await runtime.create("task-timeout", path.join(ROOT, "tasks", "task-timeout"));
  const result = await runtime.exec(session, { prompt: "x", timeoutMs: 1500 }, () => {});
  assert.equal(result.ok, true);
  assert.equal(receivedTimeout, 1500);
});
