import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeJobEvent, statusForTool, statusLabel, toolLabel } from "../../lib/job/events";
import type { JobEvent, JobStatus } from "../../lib/job/events";

test("1. serializeJobEvent → NDJSON 单行 + 可解析回原对象", () => {
  const event: JobEvent = { type: "tool", name: "Read", label: "读取文件" };
  const line = serializeJobEvent(event);
  assert.ok(line.endsWith("\n"));
  assert.deepEqual(JSON.parse(line), event);
});

test("2. 各事件形态均可序列化往返", () => {
  const events: JobEvent[] = [
    { type: "status", status: "queued", message: "任务已排队" },
    { type: "progress", percent: 42, detail: "正在处理" },
    { type: "artifact", artifact: { id: "a1", kind: "markdown", name: "r.md", mime: "text/markdown", size: 5, status: "ready", downloadUrl: "/api/artifacts/a1" } },
    { type: "result", summary: "完成" },
    { type: "error", code: "sandbox_timeout", message: "超时" },
    { type: "done", exitCode: 0 },
  ];
  for (const event of events) {
    assert.deepEqual(JSON.parse(serializeJobEvent(event)), event);
  }
});

test("3. statusForTool：常见工具 → 对应阶段", () => {
  assert.equal(statusForTool("Read"), "reading_files");
  assert.equal(statusForTool("Glob"), "reading_files");
  assert.equal(statusForTool("Grep"), "reading_files");
  assert.equal(statusForTool("Look"), "reading_files");
  assert.equal(statusForTool("Write"), "editing");
  assert.equal(statusForTool("Edit"), "editing");
  assert.equal(statusForTool("MultiEdit"), "editing");
  assert.equal(statusForTool("Bash"), "running_check");
  assert.equal(statusForTool("Check"), "running_check");
  assert.equal(statusForTool("Generate"), "generating_artifact");
  assert.equal(statusForTool("MakePptx"), "generating_artifact");
  assert.equal(statusForTool("Think"), "planning");
  assert.equal(statusForTool("Task"), "planning");
  assert.equal(statusForTool(""), "planning");
  assert.equal(statusForTool(undefined as unknown as string), "planning");
});

test("4. toolLabel / statusLabel 文案", () => {
  assert.equal(toolLabel("Read"), "读取文件");
  assert.equal(toolLabel("Bash"), "执行命令");
  assert.equal(toolLabel("Nope"), "处理文件");
  const all: JobStatus[] = ["queued", "creating_workspace", "uploading_files", "analyzing_image", "reading_files", "planning", "editing", "running_check", "generating_artifact", "done", "failed"];
  for (const status of all) assert.ok(statusLabel(status).length > 0);
  assert.equal(statusLabel("done"), "已完成");
  assert.equal(statusLabel("failed"), "处理失败");
});
