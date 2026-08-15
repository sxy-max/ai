/** Tool Registry 2.0 测试（V1.2 WP11）：元数据/授权/超时。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizedTools, runTool, TOOL_REGISTRY, listTools } from "../../lib/tools/registry";

test("工具元数据：能力/超时/副作用/结果 schema 集中声明", () => {
  const read = TOOL_REGISTRY["filesystem.read"];
  assert.ok(read.capabilities?.includes("file_read"));
  assert.equal(read.timeoutMs, 10_000);
  assert.deepEqual(read.sideEffects, []);
  assert.ok(read.resultSchema?.includes("{ok"));

  const write = TOOL_REGISTRY["filesystem.write"];
  assert.ok(write.capabilities?.includes("file_write"));
  assert.ok(write.sideEffects?.includes("filesystem-write"));

  const python = TOOL_REGISTRY["code.python.exec"];
  assert.ok(python.capabilities?.includes("code_execution"));
  assert.ok(python.sideEffects?.includes("process-spawn"));
  assert.deepEqual(python.runtimeAvailability, ["claude-code", "agentscope"]);
});

test("授权：按能力查询（file_read 覆盖读/解压/注册/视觉工具）", () => {
  const tools = authorizedTools({ capabilities: ["file_read"] });
  assert.ok(tools.includes("filesystem.read"));
  assert.ok(tools.includes("filesystem.list"));
  assert.ok(tools.includes("data.csv.read"));
  assert.ok(tools.includes("archive.extract"));
  assert.ok(tools.includes("artifact.register"));
  assert.ok(!tools.includes("code.python.exec"), "代码执行不因 file_read 授权");
});

test("授权：代码执行能力只授权 code.python.exec", () => {
  const tools = authorizedTools({ capabilities: ["code_execution"] });
  assert.deepEqual(tools, ["code.python.exec"]);
});

test("授权：ZIP 任务经 extra 获得 archive 工具", () => {
  const tools = authorizedTools({ capabilities: ["file_read"], extra: ["archive.extract", "archive.pack"] });
  assert.ok(tools.includes("archive.extract"));
  assert.ok(tools.includes("archive.pack"));
});

test("授权：runtime 过滤（runtimeAvailability 匹配才授权）", () => {
  const forClaudeCode = authorizedTools({ capabilities: ["code_execution"], runtime: "claude-code" });
  assert.ok(forClaudeCode.includes("code.python.exec"));
  const forDeterministic = authorizedTools({ capabilities: ["code_execution"], runtime: "deterministic" });
  assert.equal(forDeterministic.length, 0, "deterministic runtime 无代码执行工具");
});

test("执行超时：超过 timeoutMs 的工具返回 TOOL_TIMEOUT（不挂死）", async () => {
  const slowName = "test.slow";
  (TOOL_REGISTRY as Record<string, unknown>)[slowName] = {
    name: slowName,
    description: "slow",
    inputSchema: {},
    permission: "agent",
    capabilities: [],
    timeoutMs: 200,
    sideEffects: [],
    resultSchema: "{}",
    execute: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, output: "late" }), 5000)),
  };
  const result = await runTool(slowName, {}, { taskId: "t", userId: "u" });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /TOOL_TIMEOUT/);
});

test("未知工具：明确错误", async () => {
  const result = await runTool("nonexistent.tool", {}, { taskId: "t", userId: "u" });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /未知工具/);
});

test("listTools 带元数据", () => {
  const tools = listTools();
  const read = tools.find((t) => t.name === "filesystem.read");
  assert.ok(read);
  assert.ok(read.capabilities.includes("file_read"));
  assert.equal(read.timeoutMs, 10_000);
});
