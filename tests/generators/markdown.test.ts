import assert from "node:assert/strict";
import { test } from "node:test";
import { generateMarkdown } from "../../lib/generators/markdown";

test("1. 生成 Markdown：标题 + 小节 + 要点", async () => {
  const out = await generateMarkdown({ message: "文档：Go AI。第一节讲功能。第二节讲优势。" });
  assert.equal(out.kind, "markdown");
  assert.equal(out.mime, "text/markdown");
  assert.match(out.filename, /\.md$/);
  const md = out.content.toString("utf8");
  assert.ok(md.startsWith("# "));
  assert.ok(md.includes("# Go AI"));
  assert.ok(md.includes("## 第一节讲功能"));
  assert.ok(md.includes("- 第二节讲优势"));
});

test("2. 空内容也有标题兜底", async () => {
  const out = await generateMarkdown({ message: "" });
  assert.ok(out.content.toString("utf8").startsWith("# 演示文稿"));
});
