/** Browser 接入执行链测试（V1.4 WP19/20）：策略授权 + 沙盒工具桥 + 研究意图检测。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planExecutionPolicy } from "../../lib/policy/executionPolicy";
import { requirementsFromPlan } from "../../lib/policy/capabilities";
import { buildExecutionPlan } from "../../lib/tasks/executionPlan";
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
