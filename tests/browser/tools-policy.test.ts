/** Browser 接入执行链测试（V1.4 WP19/20）：策略授权 + 沙盒工具桥 + 研究意图检测。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planExecutionPolicy } from "../../lib/policy/executionPolicy";
import { requirementsFromPlan } from "../../lib/policy/capabilities";
import { buildExecutionPlan } from "../../lib/tasks/executionPlan";
import { sandboxManagerExecutor } from "../../lib/sandbox/runtimeProtocol";
import { listTools } from "../../lib/tools/registry";

const fakeTask = { id: "t1", type: "agent_workspace" as const, goal: "" };

test("研究类 goal（查资料/搜新闻）→ capabilities 含 browser", () => {
  for (const goal of ["查一下最近的 AI 新闻", "搜索并整理三篇资料", "调研竞品并写报告", "根据官网信息整理网页内容"]) {
    const plan = buildExecutionPlan({ ...fakeTask, goal }, []);
    assert.ok(plan.capabilities.includes("browser"), `goal "${goal}" 应授权 browser（got ${plan.capabilities}）`);
  }
});

test("非研究类 goal 不授权 browser", () => {
  const plan = buildExecutionPlan({ ...fakeTask, goal: "把这张图片改成深色背景" }, [{ filename: "a.png" }]);
  assert.ok(!plan.capabilities.includes("browser"));
});

test("policy 按 browser 能力授权浏览器工具集", () => {
  const policy = planExecutionPolicy({
    requirements: requirementsFromPlan({ taskType: "workspace_agent", needsVision: false, needsWorkspace: true, expectedArtifacts: ["file"], capabilities: ["agent", "workspace", "browser"] }),
    availableRuntimes: ["claude-code"],
  });
  assert.ok(policy.tools.includes("browser.navigate"), `tools=${policy.tools}`);
  assert.ok(policy.tools.includes("browser.screenshot"));
  assert.ok(policy.tools.includes("browser.download"));
});

test("browser 工具已在 Tool Registry 注册并可枚举", () => {
  const names = listTools().map((t) => t.name);
  for (const n of ["browser.navigate", "browser.read_page", "browser.click", "browser.type", "browser.scroll", "browser.screenshot", "browser.download", "browser.back"]) {
    assert.ok(names.includes(n), `${n} 应注册`);
  }
});

test("sandboxManagerExecutor 的 browser 桥：navigate 经 host 执行（fake manager）", async () => {
  const fakeManager = {
    readFile: async () => ({ ok: false, error: "not used" }),
    writeFile: async () => ({ ok: false, error: "not used" }),
    listFiles: async () => ({ ok: false, error: "not used", files: [] }),
    exec: async () => ({ ok: false, error: "not used" }),
  } as never;
  const executor = sandboxManagerExecutor({ sandboxId: "s1", workspaceRoot: ".", manager: fakeManager, allowedNames: ["browser.navigate"] });
  const result = await executor.executeTool({
    id: "c1",
    name: "browser.navigate",
    arguments: { url: "data:text/html,<h1>x</h1>" }, // 被安全策略拒绝 → error 而非崩溃
    timeoutMs: 30_000,
  });
  assert.equal(result.status, "error");
  assert.match(String(result.stderr || ""), /BLOCKED_URL/);
});

test("sandboxManagerExecutor 未授权工具拒绝执行", async () => {
  const fakeManager = {} as never;
  const executor = sandboxManagerExecutor({ sandboxId: "s1", workspaceRoot: ".", manager: fakeManager, allowedNames: [] });
  const result = await executor.executeTool({ id: "c2", name: "browser.navigate", arguments: { url: "https://example.com" }, timeoutMs: 30_000 });
  assert.equal(result.status, "error");
  assert.match(String(result.stderr || ""), /未授权/);
});
