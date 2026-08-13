import assert from "node:assert/strict";
import { test } from "node:test";
import { generateHtml } from "../../lib/generators/html";

test("1. 生成合法 HTML：结构完整 + 标题正确", async () => {
  const out = await generateHtml({ message: "生成一个网页，主题：Go AI 产品介绍，第一段讲功能，第二段讲优势" });
  assert.equal(out.kind, "html");
  assert.equal(out.mime, "text/html");
  assert.match(out.filename, /\.html$/);
  const html = out.content.toString("utf8");
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes("<title>Go AI 产品介绍</title>"));
  assert.ok(html.includes("第一段讲功能"));
  assert.ok(html.includes("第二段讲优势"));
});

test("2. 用户文本全部转义（防注入）", async () => {
  const payload = "生成一个网页，标题：<script>alert(1)</script>，内容：<img src=x onerror=alert(2)> 以及 & ' 引号";
  const out = await generateHtml({ message: payload });
  const html = out.content.toString("utf8");
  assert.ok(!html.includes("<script>"), "原始 <script> 不应出现");
  assert.ok(!html.includes("<img"), "原始标签不应出现");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp;"));
});
