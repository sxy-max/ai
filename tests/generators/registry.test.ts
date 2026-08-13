import assert from "node:assert/strict";
import { test } from "node:test";
import { generateArtifact, isGeneratorKind } from "../../lib/generators/registry";

test("1. isGeneratorKind：支持集合", () => {
  assert.equal(isGeneratorKind("pptx"), true);
  assert.equal(isGeneratorKind("html"), true);
  assert.equal(isGeneratorKind("csv"), true);
  assert.equal(isGeneratorKind("markdown"), true);
  assert.equal(isGeneratorKind("json"), false);
  assert.equal(isGeneratorKind("zip"), false);
  assert.equal(isGeneratorKind(undefined), false);
});

test("2. 支持的 kind → 产出对应文件", async () => {
  const pptx = await generateArtifact("pptx", { message: "两页 PPT" });
  assert.equal(pptx.kind, "pptx");
  assert.match(pptx.filename, /\.pptx$/);
  const html = await generateArtifact("html", { message: "一个网页" });
  assert.equal(html.kind, "html");
  const csv = await generateArtifact("csv", { message: "一张表" });
  assert.equal(csv.kind, "csv");
  const md = await generateArtifact("markdown", { message: "一份文档" });
  assert.equal(md.kind, "markdown");
});

test("3. 不支持的 kind → 抛 GeneratorError(unsupported_kind)", async () => {
  await assert.rejects(
    generateArtifact("json", { message: "x" }),
    (e: any) => e?.code === "unsupported_kind"
  );
  await assert.rejects(
    generateArtifact("zip", { message: "x" }),
    (e: any) => e?.code === "unsupported_kind"
  );
});
