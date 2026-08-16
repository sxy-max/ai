/** External Tool Executor 测试（V1.5）：AgentScope 外部工具协议 Go AI 侧实现。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { executeExternalTool, executeExternalTools } from "../lib/sandbox/externalToolExecutor";

function ctx(): { workspaceRoot: string } {
  return { workspaceRoot: fs.mkdtempSync(path.join(os.tmpdir(), "ext-tool-")) };
}

test("Write：写文件到 workspace（路径越界拒绝）", async () => {
  const c = ctx();
  const r = await executeExternalTool({ id: "t1", name: "Write", input: JSON.stringify({ file_path: "output/note.md", content: "hello" }) }, c);
  assert.equal(r.state, "success");
  assert.equal(fs.readFileSync(path.join(c.workspaceRoot, "output", "note.md"), "utf8"), "hello");
  const escape = await executeExternalTool({ id: "t2", name: "Write", input: JSON.stringify({ file_path: "../../etc/passwd", content: "x" }) }, c);
  assert.equal(escape.state, "error", "路径越界应拒绝");
});

test("Read：读文件 + 缺失报错", async () => {
  const c = ctx();
  fs.mkdirSync(path.join(c.workspaceRoot, "a"), { recursive: true });
  fs.writeFileSync(path.join(c.workspaceRoot, "a", "x.txt"), "内容");
  const ok = await executeExternalTool({ id: "r1", name: "Read", input: JSON.stringify({ file_path: "a/x.txt" }) }, c);
  assert.equal(ok.output, "内容");
  const miss = await executeExternalTool({ id: "r2", name: "Read", input: JSON.stringify({ file_path: "nope.txt" }) }, c);
  assert.equal(miss.state, "error");
});

test("Bash：执行命令（cwd=workspace）", async () => {
  const c = ctx();
  const r = await executeExternalTool({ id: "b1", name: "Bash", input: JSON.stringify({ command: "echo hi > out.txt && cat out.txt" }) }, c);
  assert.equal(r.state, "success");
  assert.match(r.output, /hi/);
  assert.ok(fs.existsSync(path.join(c.workspaceRoot, "out.txt")));
});

test("Edit：替换文本；Grep：行匹配；Glob：列目录", async () => {
  const c = ctx();
  fs.writeFileSync(path.join(c.workspaceRoot, "f.md"), "旧文本\n第二行");
  const e = await executeExternalTool({ id: "e1", name: "Edit", input: JSON.stringify({ file_path: "f.md", old_string: "旧文本", new_string: "新文本" }) }, c);
  assert.equal(e.state, "success");
  assert.match(fs.readFileSync(path.join(c.workspaceRoot, "f.md"), "utf8"), /新文本/);
  const g = await executeExternalTool({ id: "g1", name: "Grep", input: JSON.stringify({ path: "f.md", pattern: "第二行" }) }, c);
  assert.match(g.output, /第二行/);
  const gl = await executeExternalTool({ id: "l1", name: "Glob", input: JSON.stringify({ path: "." }) }, c);
  assert.match(gl.output, /f\.md/);
});

test("批量执行 + 未知工具报错", async () => {
  const c = ctx();
  const results = await executeExternalTools([
    { id: "m1", name: "Write", input: JSON.stringify({ file_path: "a.txt", content: "x" }) },
    { id: "m2", name: "UnknownTool", input: "{}" },
  ], c);
  assert.equal(results.length, 2);
  assert.equal(results[0].state, "success");
  assert.equal(results[1].state, "error");
});
