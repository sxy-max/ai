/** PreviewService 测试（V1.4 WP17-18）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { artifactService } from "../../lib/artifacts/service";
import { previewService } from "../../lib/artifacts/preview";
import { SpreadsheetGenerator } from "../../lib/generators/spreadsheetGenerator";
import { DocumentGenerator } from "../../lib/generators/documentGenerator";
import { PdfGenerator } from "../../lib/generators/pdfGenerator";
import { WebGenerator } from "../../lib/generators/webGenerator";

process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-artifacts-preview-test");

test("XLSX 预览：table HTML + 元数据（sheet/行/列）", async () => {
  const gen = new SpreadsheetGenerator();
  const out = await gen.generate({ goal: "表格", fileContext: "| 名称 | 数值 |\n| A | 1 |" });
  const id = artifactService.createArtifact({ filename: "t.xlsx", content: out.content, kind: "xlsx", source: "agent" }).id;
  const preview = await previewService.generatePreview(id, "xlsx");
  assert.equal(preview.previewType, "spreadsheet");
  assert.match(preview.previewAssets[0].content || "", /<table/);
  assert.equal(preview.metadata.sheets, 1);
});

test("DOCX 预览：文本提取 + 缓存（第二次 cached）", async () => {
  const gen = new DocumentGenerator();
  const out = await gen.generate({ goal: "文档", fileContext: "# 标题\n\n正文段落" });
  const id = artifactService.createArtifact({ filename: "d.docx", content: out.content, kind: "docx", source: "agent" }).id;
  const first = await previewService.generatePreview(id, "docx");
  assert.equal(first.previewType, "document");
  assert.match(first.previewAssets[0].content || "", /标题|正文/);
  const second = await previewService.generatePreview(id, "docx");
  assert.equal(second.cached, true, "预览应缓存");
  assert.ok(second.previewAssets[0].url, "缓存后返回 url");
});

test("HTML 预览：原样内容", async () => {
  const gen = new WebGenerator();
  const out = await gen.generate({ goal: "页面" });
  const id = artifactService.createArtifact({ filename: "p.html", content: out.content, kind: "html", source: "agent" }).id;
  const preview = await previewService.generatePreview(id, "html");
  assert.equal(preview.previewType, "webpage");
  assert.match(preview.previewAssets[0].content || "", /<html/i);
});

test("PDF 预览：page png（data URL 内联，不缓存）", async () => {
  const gen = new PdfGenerator();
  const out = await gen.generate({ goal: "PDF", fileContext: "# 标题" });
  const id = artifactService.createArtifact({ filename: "d.pdf", content: out.content, kind: "pdf", source: "agent" }).id;
  const preview = await previewService.generatePreview(id, "pdf");
  assert.equal(preview.previewType, "pdf");
  assert.ok(preview.previewAssets.length >= 1);
});

test("ZIP 预览：file tree", async () => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("a.html", "<p>a</p>");
  zip.folder("css")!.file("style.css", "body{}");
  const buf = await zip.generateAsync({ type: "nodebuffer" }) as Buffer;
  const id = artifactService.createArtifact({ filename: "z.zip", content: buf, kind: "zip", source: "agent" }).id;
  const preview = await previewService.generatePreview(id, "zip");
  assert.equal(preview.previewType, "archive");
  assert.match(preview.previewAssets[0].content || "", /a\.html/);
  assert.match(preview.previewAssets[0].content || "", /style\.css/);
});

test("PPTX 预览：slideCount 元数据（无缩略图，不报错）", async () => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  for (let i = 1; i <= 3; i++) zip.file(`ppt/slides/slide${i}.xml`, "<p:sld/>");
  const buf = await zip.generateAsync({ type: "nodebuffer" }) as Buffer;
  const id = artifactService.createArtifact({ filename: "p.pptx", content: buf, kind: "pptx", source: "agent" }).id;
  const preview = await previewService.generatePreview(id, "pptx");
  assert.equal(preview.previewType, "presentation");
  assert.equal(preview.metadata.slideCount, 3);
  assert.equal(preview.previewAssets.length, 0, "无 LibreOffice 时不出缩略图");
});

test("image 预览：data URL 内联 + 真实 mime（不缓存）", async () => {
  // 1x1 透明 PNG
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const id = artifactService.createArtifact({ filename: "i.png", content: png, kind: "image", mimeType: "image/png", source: "agent" }).id;
  const preview = await previewService.generatePreview(id, "image");
  assert.equal(preview.previewType, "image");
  assert.match(preview.previewAssets[0].content || "", /data:image\/png;base64,/);
  const second = await previewService.generatePreview(id, "image");
  assert.equal(second.cached, false, "image 不落盘缓存");
});

test("text 预览：原始内容截断", async () => {
  const id = artifactService.createArtifact({ filename: "t.md", content: Buffer.from("# 标题\n\n正文"), kind: "markdown", source: "agent" }).id;
  const preview = await previewService.generatePreview(id, "markdown");
  assert.equal(preview.previewType, "text");
  assert.match(preview.previewAssets[0].content || "", /标题/);
});

test("未知 kind：previewType=none，不出资产", async () => {
  const id = artifactService.createArtifact({ filename: "u.bin", content: Buffer.from([1, 2, 3]), source: "agent" }).id; // kind 推断为 unknown
  const preview = await previewService.generatePreview(id, "unknown");
  assert.equal(preview.previewType, "none");
  assert.equal(preview.previewAssets.length, 0);
});
