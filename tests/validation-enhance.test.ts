/** Validation 增强测试：xlsx/docx/pdf 格式校验 + PPTX 页数契约。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { validateArtifactFormat, countPptxSlides } from "../lib/artifacts/validator";
import { validateTaskCompletion } from "../lib/tasks/completion";

process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-ve-artifacts");

async function pptxBytes(slides: number): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("ppt/presentation.xml", "<p:presentation/>");
  for (let i = 1; i <= slides; i++) zip.file(`ppt/slides/slide${i}.xml`, "<p:sld/>");
  return zip.generateAsync({ type: "nodebuffer" });
}

test("validator: xlsx 真实结构通过", async () => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("xl/workbook.xml", "<workbook/>");
  zip.file("xl/worksheets/sheet1.xml", "<worksheet/>");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const r = await validateArtifactFormat("a1", "表格.xlsx", "xlsx", buf);
  assert.equal(r?.ok, true);
  assert.equal(r?.checks.sheets.ok, true);
});

test("validator: xlsx 缺 workbook → 失败", async () => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const r = await validateArtifactFormat("a2", "坏.xlsx", "xlsx", buf);
  assert.equal(r?.ok, false);
  assert.equal(r?.checks.workbook.ok, false);
});

test("validator: docx 结构校验", async () => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", "<w:document/>");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const r = await validateArtifactFormat("a3", "文档.docx", "docx", buf);
  assert.equal(r?.ok, true);
  const bad = await validateArtifactFormat("a4", "坏.docx", "docx", Buffer.from("not a docx"));
  assert.equal(bad?.ok, false);
});

test("validator: pdf 头尾校验", async () => {
  const good = Buffer.from("%PDF-1.4\n...\n%%EOF");
  assert.equal((await validateArtifactFormat("a5", "报告.pdf", "pdf", good))?.ok, true);
  const bad = Buffer.from("not pdf at all");
  assert.equal((await validateArtifactFormat("a6", "假.pdf", "pdf", bad))?.ok, false);
});

test("completion: PPTX 页数契约（两页 PPT 产出 3 页 = 未完成）", async () => {
  const buf = await pptxBytes(3);
  const { artifactService } = await import("../lib/artifacts/service");
  const created = await artifactService.createArtifact({ filename: "演示.pptx", content: buf, kind: "pptx", source: "test" });
  const artifact = { id: created.id, name: "演示", type: "pptx", size: buf.length, status: "ready" as const, downloadUrl: `/api/artifacts/${created.id}` };
  const contract = {
    expectations: [{ kind: "pptx", minCount: 1, validate: "format" as const, pageConstraint: { min: 1, max: 2 } }],
    minArtifacts: 1,
    validationPolicy: "strict" as const,
  };
  const slides = await countPptxSlides(buf);
  assert.equal(slides, 3);
  const verdict = await validateTaskCompletion("t1", [artifact], contract, async () => null);
  assert.notEqual(verdict.status, "completed");
  if (verdict.status !== "completed") {
    assert.ok(verdict.reason.includes("页") || verdict.reason.includes("格式"), verdict.reason);
  }
});

test("completion: 两页 PPT 产出 2 页 = 完成", async () => {
  const buf = await pptxBytes(2);
  const artifact = { id: "p2", name: "演示", type: "pptx", size: buf.length, status: "ready" as const };
  const contract = {
    expectations: [{ kind: "pptx", minCount: 1, validate: "format" as const, pageConstraint: { min: 1, max: 2 } }],
    minArtifacts: 1,
    validationPolicy: "strict" as const,
  };
  const verdict = await validateTaskCompletion("t2", [artifact], contract, async () => null);
  assert.equal(verdict.status, "completed");
});
