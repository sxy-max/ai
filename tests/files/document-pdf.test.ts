/** DocumentModel + PDF Pipeline 测试（V1.4 WP11-13）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToDocument, textToDocument, htmlToDocument, documentSummary } from "../../lib/files/documentModel";
import { PdfGenerator } from "../../lib/generators/pdfGenerator";
import { summarizePdf } from "../../lib/files/pdfReader";

test("MD → DocumentModel：标题/分节/段落/列表/表格", () => {
  const md = "# 报告\n\n## 第一节\n\n正文内容。\n\n- 要点一\n- 要点二\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n";
  const doc = markdownToDocument(md);
  assert.equal(doc.title, "报告");
  assert.deepEqual(doc.headings, ["报告", "第一节"]);
  assert.ok(doc.paragraphs.some((p) => p.includes("正文内容")));
  assert.deepEqual(doc.sections[1].bullets, ["要点一", "要点二"]);
  assert.equal(doc.tables.length, 1);
  assert.equal(doc.tables[0][1][0], "1");
});

test("HTML → DocumentModel：标题/段落/图片", () => {
  const html = '<html><head><title>页面</title></head><body><h1>标题</h1><p>段落</p><img src="a.png"></body></html>';
  const doc = htmlToDocument(html);
  assert.equal(doc.title, "页面");
  assert.deepEqual(doc.headings, ["标题"]);
  assert.ok(doc.paragraphs.includes("段落"));
  assert.equal(doc.images.length, 1);
});

test("documentSummary：结构化摘要（Agent 上下文）", () => {
  const doc = markdownToDocument("# 报告\n\n## 节\n内容\n\n| a | b |\n| - | - |\n| 1 | 2 |");
  const summary = documentSummary(doc);
  assert.match(summary, /报告/);
  assert.match(summary, /1 个表格/);
});

test("PDF 生成：真实 PDF（%PDF 头 + validate）", async () => {
  const gen = new PdfGenerator();
  const out = await gen.generate({ goal: "测试 PDF", fileContext: "# 标题\n\n段落内容" });
  assert.equal(out.content.subarray(0, 5).toString(), "%PDF-");
  const report = await gen.validate(out.content);
  assert.equal(report.ok, true);
});

test("PDF 读取：summarizePdf 提取文本/页数", async () => {
  const gen = new PdfGenerator();
  const out = await gen.generate({ goal: "可读性测试", fileContext: "# 可读标题\n\n这段文字应该被 PDF 提取出来。" });
  const summary = await summarizePdf(out.content);
  assert.ok(summary);
  assert.ok(summary!.pageCount >= 1);
  assert.match(summary!.text, /可读/);
});
