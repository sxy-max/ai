/** Preflight 决策层测试：rules（确定性）+ models（Auto）+ build（组合）。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRules, artifactKindFromGoal, pageConstraintFromGoal as pc } from "../lib/preflight/rules";
import { resolveMainModelSync } from "../lib/preflight/models";
import { buildDirective } from "../lib/preflight/build";
import { attachmentsFromFiles } from "../lib/preflight/attachments";

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

test("models: reasoning → Luna 优先", () => {
  assert.equal(resolveMainModelSync(["reasoning"], "high"), "gpt-5.6-luna");
});

test("models: general → Luna（健康时）", () => {
  assert.equal(resolveMainModelSync(["general"], "auto"), "gpt-5.6-luna");
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
  await assert.rejects(() => buildDirective({ goal: "写一个程序", health }), /PREFLIGHT_NO_MODEL/);
});

test("rules: 写 Python 程序 → coding 工作区任务（不落 chat）", () => {
  const v = applyRules({ goal: "写一个 Python 程序，读取 CSV 并计算每列平均值，保存为 analyze.py 并执行验证", attachments: [{ kind: "spreadsheet", mime: "text/csv", name: "data.csv" }] });
  assert.equal(v.taskType, "coding_task");
  assert.ok(v.capabilities.includes("coding"));
  assert.equal(v.deliveryContract.kind, "code");
  assert.equal(v.profile, "workspace");
});

test("rules: PDF 文档 → pdf（不被 docx 的『文档』误判）", () => {
  const v = applyRules({ goal: "生成一份关于太阳系的 PDF 文档（含标题与三个段落）" });
  assert.equal(v.deliveryContract.kind, "pdf");
});

test("rules: 综合任务（图+CSV+网站+打包）→ zip 契约（不被 xlsx 中间产物误判）", () => {
  const v = applyRules({
    goal: "根据参考图重构网站页面，整合 data.csv 的销量数据为表格，保证移动端无横向滚动，完成后打包为 zip 交付",
    attachments: [
      { kind: "archive", mime: "application/zip", name: "site.zip" },
      { kind: "image", mime: "image/png", name: "reference.png" },
      { kind: "spreadsheet", mime: "text/csv", name: "data.csv" },
    ],
  });
  assert.equal(v.deliveryContract.kind, "zip");
  assert.ok(v.capabilities.includes("vision"));
  assert.ok(v.capabilities.includes("spreadsheet"));
});

test("attachments: PNG 无 MIME 时按扩展名识别为 image（Blob 无 type 上传回归，2026-08-17）", () => {
  const a = attachmentsFromFiles([{ filename: "reference.png" }, { filename: "data.csv" }, { filename: "photo.JPG" }, { filename: "noext" }]);
  assert.equal(a[0].kind, "image");
  assert.equal(a[1].kind, "spreadsheet");
  assert.equal(a[2].kind, "image");
  assert.equal(a[3].kind, "file");
});
