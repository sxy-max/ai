/** Generator Engine + Layout Engine 测试（V1.4 WP3-7）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLayout, suggestLayout, SAFE_AREA, layoutOptions } from "../../lib/generators/layoutEngine";
import { generatorFor, isGeneratorSupported } from "../../lib/generators/engine";
import { PresentationGenerator } from "../../lib/generators/presentationGenerator";
import { SpreadsheetGenerator } from "../../lib/generators/spreadsheetGenerator";
import { DocumentGenerator } from "../../lib/generators/documentGenerator";
import { WebGenerator } from "../../lib/generators/webGenerator";

/* ---------- WP5 Layout Engine ---------- */

test("布局：标题区 + 正文区在 safeArea 内", () => {
  const result = computeLayout("title-content", { title: "标题", sections: ["要点一", "要点二"] });
  assert.equal(result.issues.length, 0);
  const title = result.blocks.find((b) => b.kind === "title");
  assert.ok(title);
  assert.ok(title.x >= SAFE_AREA.x && title.y >= SAFE_AREA.y);
  assert.ok(title.x + title.w <= SAFE_AREA.x + SAFE_AREA.w + 0.01);
});

test("布局：文字溢出检测（高密度 → TEXT_OVERFLOW）", () => {
  const result = computeLayout("title-content", { title: "标题", sections: Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 段非常长的内容需要被压缩以适应有限的版面空间`.repeat(4)) });
  assert.ok(result.issues.some((i) => /TEXT_OVERFLOW/.test(i)), `应检测溢出: ${result.issues.join(",")}`);
  assert.ok(result.density > 1);
});

test("布局：项目符号过多 → BULLET_OVERFLOW", () => {
  const result = computeLayout("title-content", { title: "标题", sections: Array.from({ length: 9 }, (_, i) => `要点 ${i + 1}`) });
  assert.ok(result.issues.some((i) => /BULLET_OVERFLOW/.test(i)));
});

test("布局：deterministic（同输入 → 同输出）", () => {
  const content = { title: "产品介绍", sections: ["功能一", "功能二", "功能三"], chartHint: true };
  const a = computeLayout("data", content);
  const b = computeLayout("data", content);
  assert.deepEqual(a.blocks, b.blocks);
});

test("布局启发式：quote→quote；stats→data；多段→two-column；公式→title-content", () => {
  assert.equal(suggestLayout({ title: "t", sections: [], quote: "名言" }), "quote");
  assert.equal(suggestLayout({ title: "t", sections: ["a"], stats: [{ label: "x", value: "1" }] }), "data");
  assert.equal(suggestLayout({ title: "t", sections: Array.from({ length: 6 }, (_, i) => `s${i}`) }), "two-column");
  assert.equal(suggestLayout({ title: "t", sections: ["a"], equations: ["E=mc^2"] }), "title-content");
});

test("布局选项完整（10 种原语）", () => {
  assert.deepEqual(layoutOptions(), ["title", "title-content", "two-column", "comparison", "timeline", "process", "data", "image-focus", "quote", "summary"]);
});

/* ---------- WP3 Generator Engine ---------- */

test("engine 注册表：presentation/spreadsheet/document/webpage 支持；pdf/image 明确不支持", () => {
  assert.equal(isGeneratorSupported("presentation"), true);
  assert.equal(isGeneratorSupported("spreadsheet"), true);
  assert.equal(isGeneratorSupported("document"), true);
  assert.equal(isGeneratorSupported("webpage"), true);
  assert.equal(isGeneratorSupported("pdf"), false);
  assert.equal(isGeneratorSupported("image"), false);
});

test("PresentationGenerator：生成真实 PPTX + validate（ZIP 容器/页数）", async () => {
  const gen = new PresentationGenerator();
  const out = await gen.generate({ goal: "做一份两页的产品介绍 PPT", spec: { title: "产品", slides: [{ title: "一", sections: ["A", "B"], layout: "title-content" }, { title: "二", sections: ["C"], layout: "title-content" }] } });
  assert.equal(out.content.subarray(0, 2).toString(), "PK");
  assert.equal(out.metadata.slideCount, 2);
  const report = await gen.validate(out.content);
  assert.equal(report.ok, true);
});

test("SpreadsheetGenerator：生成真实 XLSX + validate + table preview", async () => {
  const gen = new SpreadsheetGenerator();
  const out = await gen.generate({ goal: "整理表格", fileContext: "| 名称 | 数值 |\n| A | 1 |\n| B | 2 |" });
  assert.equal(out.content.subarray(0, 2).toString(), "PK");
  const report = await gen.validate(out.content);
  assert.equal(report.ok, true);
  const preview = await gen.renderPreview(out.content);
  assert.ok(preview.length >= 1);
  assert.match(preview[0].data.toString("utf8"), /<table/);
});

test("DocumentGenerator：真实 DOCX + validate + 文本预览", async () => {
  const gen = new DocumentGenerator();
  const out = await gen.generate({ goal: "写文档", fileContext: "# 标题\n\n正文段落" });
  assert.equal(out.content.subarray(0, 2).toString(), "PK");
  const report = await gen.validate(out.content);
  assert.equal(report.ok, true);
  const preview = await gen.renderPreview(out.content);
  assert.ok(preview.length >= 1);
  assert.match(preview[0].data.toString("utf8"), /标题|正文/);
});

test("WebGenerator：HTML 结构验证（缺失结构 → 修复）", async () => {
  const gen = new WebGenerator();
  const broken = Buffer.from("只有一点文字没有结构", "utf8");
  const report = await gen.validate(broken);
  assert.equal(report.ok, false);
  const repaired = await gen.repair({ goal: "页面" }, report.issues);
  const reReport = await gen.validate(repaired.content);
  assert.equal(reReport.ok, true, "修复后应通过验证");
});
