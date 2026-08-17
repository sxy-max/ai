import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager } from "../../lib/workspace/service";
import { runAgentJob } from "../../lib/agent/runner";
import type { AgentRuntimeAdapter, SandboxRunEvent, SandboxRunRequest, SandboxRunResult } from "../../lib/sandbox/adapter";
import type { ClientArtifact } from "../../lib/artifacts/types";

const FAKE_ARTIFACT: ClientArtifact = { id: "a1", kind: "markdown", name: "report.md", mime: "text/markdown", size: 5, status: "ready", downloadUrl: "/api/artifacts/a1" };

function fakeAdapter(opts: { events?: SandboxRunEvent[]; result?: SandboxRunResult; onRequest?: (request: SandboxRunRequest) => void }): AgentRuntimeAdapter {
  const run = async (request: SandboxRunRequest, onEvent: (event: SandboxRunEvent) => void | Promise<void>) => {
    opts.onRequest?.(request);
    for (const event of opts.events || []) await onEvent(event);
    return opts.result ?? { ok: true, exitCode: 0 };
  };
  return {
    id: "fake",
    available: true,
    async prepare() { return { ok: true }; },
    execute: run,
    run,
    async collectOutputs() { return []; },
    async cancel() {},
    async cleanup() {}
  };
}

function makeWs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "go-ai-run-"));
  const ws = new WorkspaceManager(root).createWorkspace();
  return { ws, root };
}

test("1. 正常流：任务说明写入、事件透传、artifacts 登记、job done", async () => {
  const { ws } = makeWs();
  fs.writeFileSync(path.join(ws.dirs.output, "report.md"), "# ok");
  const forwarded: string[] = [];
  const registered: { name: string; content: Buffer }[] = [];

  const adapter = fakeAdapter({
    events: [
      { type: "tool", name: "Read" },
      { type: "text", text: "正在处理" },
      { type: "artifacts", files: [{ name: "output/report.md" }] },
      { type: "done", exitCode: 0 },
    ],
  });

  const outcome = await runAgentJob(
    {
      conversationId: "conv1",
      jobId: "job1",
      prompt: "把报告改成中文",
      style: "简洁",
      workspace: ws,
      adapter,
      registerArtifact: async (name, content) => {
        registered.push({ name, content });
        return { ...FAKE_ARTIFACT, name };
      },
    },
    (event) => forwarded.push(event.type)
  );

  assert.equal(outcome.status, "done");
  assert.equal(outcome.artifactCount, 1);
  // 事件顺序：queued → creating_workspace → reading_files → tool → progress → artifact → done → status(done)
  assert.deepEqual(forwarded, ["status", "status", "status", "tool", "progress", "artifact", "done", "status"]);
  // 任务说明写入 workspace
  const taskMd = fs.readFileSync(path.join(ws.dirs.task, "task.md"), "utf8");
  assert.ok(taskMd.includes("把报告改成中文"));
  assert.ok(taskMd.includes("简洁"));
  // registerArtifact 收到文件内容
  assert.equal(registered[0].name, "output/report.md");
  assert.equal(registered[0].content.toString("utf8"), "# ok");
});

test("2. 失败（超时）：job failed、保留 error、仍发出错误事件", async () => {
  const { ws } = makeWs();
  const forwarded: string[] = [];
  const adapter = fakeAdapter({
    events: [{ type: "error", message: "沙箱执行超时" }],
    result: { ok: false, error: "sandbox_timeout", partial: false },
  });

  const outcome = await runAgentJob(
    { conversationId: "c", jobId: "job2", prompt: "x", workspace: ws, adapter, registerArtifact: async () => null },
    (event) => forwarded.push(event.type)
  );

  assert.equal(outcome.status, "failed");
  assert.ok(!outcome.result.ok);
  if (!outcome.result.ok) assert.equal(outcome.result.error, "sandbox_timeout");
  assert.ok(forwarded.includes("error"));
  assert.equal(forwarded.at(-1), "status");
});

test("3. adapter 抛异常 → 也标记 failed 而非崩掉", async () => {
  const { ws } = makeWs();
  const adapter: AgentRuntimeAdapter = {
    id: "fake", available: true,
    async prepare() { return { ok: true }; },
    async execute() { throw new Error("adapter exploded"); },
    async collectOutputs() { return []; },
    async cancel() {},
    async cleanup() {}
  };
  const outcome = await runAgentJob(
    { conversationId: "c", jobId: "job3", prompt: "x", workspace: ws, adapter, registerArtifact: async () => null },
    () => {}
  );
  assert.equal(outcome.status, "failed");
});

test("4. artifacts 逃逸路径（../）不登记；缺失文件跳过", async () => {
  const { ws } = makeWs();
  const registered: string[] = [];
  const adapter = fakeAdapter({
    events: [
      { type: "artifacts", files: [{ name: "../evil.txt" }, { name: "output/missing.md" }] },
      { type: "done", exitCode: 0 },
    ],
  });

  const outcome = await runAgentJob(
    { conversationId: "c", jobId: "job4", prompt: "x", workspace: ws, adapter, registerArtifact: async (name) => (registered.push(name), { ...FAKE_ARTIFACT, name }) },
    () => {}
  );
  assert.equal(outcome.status, "done");
  assert.equal(outcome.artifactCount, 0);
  assert.deepEqual(registered, []);
});

test("5. Cancel 信号透传：request.signal 与输入一致（取消真终止回归，2026-08-17）", async () => {
  const { ws } = makeWs();
  let gotSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const adapter = fakeAdapter({
    onRequest: (request) => { gotSignal = request.signal; },
    result: { ok: true, exitCode: 0 },
  });
  const outcome = await runAgentJob(
    { conversationId: "c", jobId: "job5", prompt: "x", workspace: ws, adapter, signal: controller.signal, registerArtifact: async () => null },
    () => {}
  );
  assert.equal(outcome.status, "done");
  assert.ok(gotSignal, "request.signal 必须透传（Cancel 才能中断容器执行）");
  assert.equal(gotSignal!.aborted, false);
  controller.abort();
  assert.equal(gotSignal!.aborted, true, "abort 后信号应同步");
});

test("6. quick 模式 final answer：agent_text 流累积为 lastResult（agent_result 占位兜底，2026-08-17）", async () => {
  const { ws } = makeWs();
  const adapter = fakeAdapter({
    events: [
      { type: "text", text: "光合作用是植物利用阳光把水和二氧化碳变成养分的过程。" },
      { type: "text", text: "它发生在叶绿体中，释放氧气。" },
      { type: "result", result: "Claude Code 执行结束（exit 0）" },
      { type: "done", exitCode: 0 },
    ],
  });
  const outcome = await runAgentJob(
    { conversationId: "c", jobId: "job6", prompt: "解释光合作用", workspace: ws, adapter, registerArtifact: async () => null },
    () => {}
  );
  assert.equal(outcome.status, "done");
  assert.ok(outcome.lastResult, "必须有 final answer");
  assert.ok(outcome.lastResult!.includes("光合作用"), "真实回答（agent_text 流）应进入 lastResult");
  assert.ok(!outcome.lastResult!.includes("执行结束"), "占位 result 不应覆盖真实回答");
});

test("7. lastResult 优先级：agent_result 非占位时优先（工具场景保留语义）", async () => {
  const { ws } = makeWs();
  const adapter = fakeAdapter({
    events: [
      { type: "text", text: "中间过程文本" },
      { type: "result", result: "自定义结果：已交付 3 个文件" },
      { type: "done", exitCode: 0 },
    ],
  });
  const outcome = await runAgentJob(
    { conversationId: "c", jobId: "job7", prompt: "做 PPT", workspace: ws, adapter, registerArtifact: async () => null },
    () => {}
  );
  assert.equal(outcome.status, "done");
  assert.ok(outcome.lastResult!.includes("自定义结果"), "非占位 result 保持优先");
});
