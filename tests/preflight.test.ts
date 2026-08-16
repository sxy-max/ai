/** Preflight 决策层测试：rules（确定性）+ models（Auto）+ build（组合）。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRules, artifactKindFromGoal, pageConstraintFromGoal as pc } from "../lib/preflight/rules";
import { resolveMainModelSync } from "../lib/preflight/models";
import { buildDirective } from "../lib/preflight/build";

test("rules: 图片+修改 → vision 工作区任务（截图改网站）", () => {
  const v = applyRules({ goal: "按照参考图修改网页", attachments: [{ kind: "image", mime: "image/png", name: "ref.png" }] });
  assert.equal(v.taskType, "vision_file_transform");
  assert.ok(v.capabilities.includes("vision"));
  assert.ok(v.capabilities.includes("coding"));
  assert.equal(v.deliveryContract.mustUseVision, true);
  assert.equal(v.deliveryContract.mustChangeFiles, true);
  assert.equal(v.profile, "workspace");
});

test("rules: 图片+纯问答 → 视觉问答（不进 Agent 产物链）", () => {
  const v = applyRules({ goal: "这张图里有什么", attachments: [{ kind: "image", mime: "image/jpeg", name: "a.jpg" }] });
  assert.equal(v.taskType, "chat");
  assert.ok(v.capabilities.includes("vision"));
  assert.equal(v.deliveryContract.validate, "none");
  assert.equal(v.profile, "quick");
});

test("rules: 做两页 PPT → presentation + 页数契约", () => {
  const v = applyRules({ goal: "帮我做两页 PPT" });
  assert.equal(v.taskType, "artifact_generation");
  assert.ok(v.capabilities.includes("presentation"));
  assert.equal(v.deliveryContract.kind, "pptx");
  assert.equal(v.deliveryContract.pageConstraint?.max, 2);
  assert.equal(v.profile, "workspace");
});

test("rules: 整理销售数据表格 → spreadsheet 工作区任务", () => {
  const v = applyRules({ goal: "整理一份销售数据表格" });
  assert.equal(v.taskType, "artifact_generation");
  assert.ok(v.capabilities.includes("spreadsheet"));
  assert.equal(v.deliveryContract.kind, "xlsx");
});

test("rules: Excel 附件+处理 → spreadsheet 工作区（不退回 chat）", () => {
  const v = applyRules({ goal: "根据这个 Excel 做统计", attachments: [{ kind: "spreadsheet", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: "销售.xlsx" }] });
  assert.equal(v.taskType, "file_transform");
  assert.ok(v.capabilities.includes("spreadsheet"));
  assert.equal(v.deliveryContract.mustChangeFiles, true);
});

test("rules: ZIP 项目+修改 → coding 工作区", () => {
  const v = applyRules({ goal: "修改这个网站项目并打包", attachments: [{ kind: "archive", mime: "application/zip", name: "site.zip" }] });
  assert.equal(v.taskType, "file_transform");
  assert.ok(v.capabilities.includes("coding"));
});

test("rules: 项目延续（projectId）→ project_agent 持久工作区", () => {
  const v = applyRules({ goal: "把标题改大一点", projectId: "p-123" });
  assert.equal(v.taskType, "project_agent");
  assert.equal(v.workspaceMode, "project");
});

test("rules: 研究 → search+browser", () => {
  const v = applyRules({ goal: "帮我研究一下量子计算的最新进展" });
  assert.equal(v.taskType, "research");
  assert.ok(v.capabilities.includes("search"));
  assert.ok(v.capabilities.includes("browser"));
});

test("rules: 高难推理 → reasoning 主模型档", () => {
  const v = applyRules({ goal: "请证明费马大定理的证明思路" });
  assert.equal(v.taskType, "reasoning");
  assert.ok(v.capabilities.includes("reasoning"));
  assert.equal(v.reasoning, "high");
});

test("rules: 普通问答 → general（fallback）", () => {
  const v = applyRules({ goal: "什么是黑洞？" });
  assert.equal(v.taskType, "chat");
  assert.deepEqual(v.capabilities, ["general"]);
  assert.equal(v.profile, "quick");
});

test("artifactKindFromGoal: 目标类型优先", () => {
  assert.equal(artifactKindFromGoal("把 CSV 转成 Excel"), "xlsx");
  assert.equal(artifactKindFromGoal("做一个三页 PPT"), "pptx");
  assert.equal(artifactKindFromGoal("生成 PDF"), "pdf");
  assert.equal(artifactKindFromGoal("写一份 Word 文档"), "docx");
  assert.equal(artifactKindFromGoal("做一个小网站"), "html");
});

test("models: coding → DeepSeek V4 Flash（默认主模型）", () => {
  assert.equal(resolveMainModelSync(["coding", "browser"], "auto"), "deepseek-v4-flash");
});

test("models: reasoning → Pro 优先", () => {
  assert.equal(resolveMainModelSync(["reasoning"], "high"), "deepseek-v4-pro");
});

test("models: general → Flash（轻量档）", () => {
  assert.equal(resolveMainModelSync(["general"], "auto"), "deepseek-v4-flash");
});

test("build: 完整组合（Excel+图片 → PPT）产出 directive", async () => {
  const d = await buildDirective({
    goal: "根据这个 Excel 和图片做三页 PPT",
    attachments: [
      { kind: "spreadsheet", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: "数据.xlsx" },
      { kind: "image", mime: "image/png", name: "风格.png" },
    ],
  });
  assert.ok(d.capabilities.includes("presentation"));
  assert.ok(d.capabilities.includes("spreadsheet"));
  assert.equal(d.mcpServers.includes("office"), true);
  assert.equal(d.deliveryContract.kind, "pptx");
  assert.equal(d.deliveryContract.pageConstraint?.max, 3);
  assert.equal(d.mainModel, "deepseek-v4-flash");
  assert.equal(d.workspaceMode, "task");
  assert.equal(d.profile, "workspace");
  assert.ok(d.policySource.startsWith("Preflight:"));
});

test("build: 语义模糊时分类模型只补判路线（不执行任务）", async () => {
  let classifyCalls = 0;
  const d = await buildDirective({
    goal: "帮我处理一下这个文件",
    attachments: [{ kind: "spreadsheet", mime: "text/csv", name: "data.csv" }],
    classify: async () => {
      classifyCalls++;
      return { capabilities: ["spreadsheet", "coding"], taskType: "file_transform" };
    },
  });
  assert.equal(classifyCalls, 0); // 附件已足够判定，无需模型
  assert.ok(d.capabilities.includes("spreadsheet"));
});

test("build: 无健康模型 → 明确错误（不随机替换）", async () => {
  const { ProviderHealthRegistry } = await import("../lib/policy/providerHealth");
  const health = new ProviderHealthRegistry();
  health.record("deepseek-v4-flash", { status: "temporary_unavailable", probedAt: Date.now() });
  health.record("deepseek-v4-pro", { status: "disabled", probedAt: Date.now() });
  health.record("kimi-k3", { status: "region_unavailable", probedAt: Date.now() });
  health.record("glm-5.2", { status: "disabled", probedAt: Date.now() });
  health.record("qwen3.8-max", { status: "disabled", probedAt: Date.now() });
  await assert.rejects(() => buildDirective({ goal: "写一个程序", health }), /PREFLIGHT_NO_MODEL/);
});
