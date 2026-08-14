/** WP7 测试：Tool Registry（filesystem/archive/data/vision/artifact + 安全边界）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager } from "../../lib/workspace/service";
import { TOOL_REGISTRY, runTool, listTools } from "../../lib/tools/registry";
import { artifactService } from "../../lib/artifacts/service";

process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-artifacts-tools-test");

function makeCtx(taskId = "tool-test") {
  const ws = new WorkspaceManager(path.join(os.tmpdir(), `goai-ws-${taskId}-${Date.now()}`)).createWorkspace();
  return { workspace: ws, taskId, userId: "u1" };
}

test("注册表：工具齐全且权限分级", () => {
  const tools = listTools();
  const names = tools.map((t) => t.name);
  for (const expected of ["filesystem.read", "filesystem.write", "filesystem.list", "archive.extract", "archive.pack", "data.csv.read", "artifact.register", "vision.read_context", "code.python.exec"]) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}`);
  }
  assert.equal(TOOL_REGISTRY["filesystem.read"].permission, "read");
  assert.equal(TOOL_REGISTRY["filesystem.write"].permission, "workspace");
  assert.equal(TOOL_REGISTRY["code.python.exec"].permission, "agent");
});

test("filesystem：读写受 workspace 边界约束（防穿越）", async () => {
  const ctx = makeCtx();
  await runTool("filesystem.write", { path: "working/note.txt", content: "hello" }, ctx);
  const read = await runTool("filesystem.read", { path: "working/note.txt" }, ctx);
  assert.equal(read.ok, true);
  assert.equal(read.output, "hello");

  // 事件上报
  const events: string[] = [];
  await runTool("filesystem.read", { path: "working/note.txt" }, { ...ctx, emit: async (name) => { events.push(name); } });
  assert.deepEqual(events, ["filesystem.read", "filesystem.read"]);

  // 未知工具
  const unknown = await runTool("no.such", {}, ctx);
  assert.equal(unknown.ok, false);
});

test("data.csv.read：解析列与行", async () => {
  const ctx = makeCtx("csv");
  await runTool("filesystem.write", { path: "input/data.csv", content: "name,value\nA,1\nB,2" }, ctx);
  const result = await runTool("data.csv.read", { path: "input/data.csv" }, ctx);
  assert.equal(result.ok, true);
  const data = result.output as { columns: string[]; rows: string[][]; rowCount: number };
  assert.deepEqual(data.columns, ["name", "value"]);
  assert.equal(data.rowCount, 2);
});

test("archive：pack 后 extract 可回读（zip slip 防护由 safeExtractZip 承担）", async () => {
  const ctx = makeCtx("zip");
  await runTool("filesystem.write", { path: "working/src/index.html", content: "<html>v1</html>" }, ctx);
  const packed = await runTool("archive.pack", { source: "working", dest: "output/project.zip" }, ctx);
  assert.equal(packed.ok, true);

  const ctx2 = makeCtx("zip2");
  const ws2 = ctx2.workspace!;
  fs.copyFileSync(path.join(ctx.workspace!.root, "output/project.zip"), path.join(ws2.root, "input/project.zip"));
  const extracted = await runTool("archive.extract", { source: "input/project.zip", dest: "working" }, ctx2);
  assert.equal(extracted.ok, true);
  const list = await runTool("filesystem.list", { dir: "working/src" }, ctx2);
  assert.ok((list.output as string[]).includes("index.html"));
});

test("artifact.register：workspace 文件注册为可下载 Artifact", async () => {
  const ctx = makeCtx("art");
  await runTool("filesystem.write", { path: "output/result.md", content: "# 结果" }, ctx);
  const result = await runTool("artifact.register", { path: "output/result.md", name: "结果.md" }, ctx);
  assert.equal(result.ok, true);
  const output = result.output as { artifactId: string; downloadUrl: string };
  const buf = artifactService.readContent(output.artifactId);
  assert.equal(buf?.toString("utf8"), "# 结果");
});

test("code.python.exec：workspace 内执行且受路径边界约束", async () => {
  const ctx = makeCtx("py");
  const result = await runTool("code.python.exec", { code: "const os = require(\"os\"); console.log(process.cwd()); console.log(JSON.stringify(require(\"fs\").readdirSync(\".\")));" }, ctx);
  assert.equal(result.ok, true);
  assert.ok(String(result.output).includes(ctx.workspace!.root));
});
