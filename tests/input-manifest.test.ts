/** InputManifest 测试（V1.4 WP45-46）：多输入文件的结构化清单（文本/xlsx/PDF/二进制）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-artifacts-input-manifest");
import { artifactService } from "../lib/artifacts/service";
import { buildInputManifest, inputManifestText, summarizeInputFile } from "../lib/tasks/inputManifest";
import { SpreadsheetGenerator } from "../lib/generators/spreadsheetGenerator";
import { PdfGenerator } from "../lib/generators/pdfGenerator";

async function artifactId(filename: string, content: Buffer | string): Promise<string> {
  const kind = filename.endsWith(".xlsx") ? "xlsx" : filename.endsWith(".pdf") ? "pdf" : filename.endsWith(".png") ? "image" : "txt";
  return artifactService.createArtifact({ filename, content, kind, source: "upload" }).id;
}

test("文本文件：预览前 1200 字符", async () => {
  const id = await artifactId("note.md", "# 标题\n\n正文内容：旋转圆环与拉格朗日量。");
  const s = await summarizeInputFile("note.md", 100, id);
  assert.match(s || "", /旋转圆环/);
});

test("XLSX：结构化摘要（sheet 数/列）而非二进制提示", async () => {
  const gen = new SpreadsheetGenerator();
  const out = await gen.generate({ goal: "表", fileContext: "| 姓名 | 数学 |\n| 张三 | 85 |" });
  const id = await artifactId("scores.xlsx", out.content);
  const s = await summarizeInputFile("scores.xlsx", out.content.length, id);
  assert.ok(s && /sheet/i.test(s), "应含 sheet 结构信息");
  assert.match(s || "", /姓名/);
});

test("PDF：页数 + 正文开头预览", async () => {
  const gen = new PdfGenerator();
  const out = await gen.generate({ goal: "pdf", fileContext: "# 物理报告\n\n拉格朗日量推导" });
  const id = await artifactId("report.pdf", out.content);
  const s = await summarizeInputFile("report.pdf", out.content.length, id);
  assert.ok(s && /PDF \d+ 页/.test(s), `应含页数：${s}`);
});

test("二进制：NUL 守卫不产生乱码预览", async () => {
  const id = await artifactId("data.bin", Buffer.from([1, 0, 2, 3, 255, 254]));
  const s = await summarizeInputFile("data.bin", 6, id);
  assert.match(s || "", /二进制/);
});

test("多输入 Manifest：全部条目 + 纯文本渲染", async () => {
  const mdId = await artifactId("a.md", "第一份材料内容");
  const xlsxId = await artifactId("b.xlsx", (await new SpreadsheetGenerator().generate({ goal: "表", fileContext: "| 列A |\n| 1 |" })).content);
  const entries = await buildInputManifest([
    { filename: "a.md", size: 20, storageKey: mdId },
    { filename: "b.xlsx", size: 100, storageKey: xlsxId },
    { filename: "img.png", size: 10, storageKey: null },
  ]);
  assert.equal(entries.length, 3);
  assert.ok(entries[0].summary, "文本有预览");
  assert.ok(entries[1].summary, "xlsx 有结构化摘要");
  assert.equal(entries[2].summary, undefined, "无存储内容不产生摘要");
  const text = inputManifestText(entries);
  assert.match(text, /a\.md/);
  assert.match(text, /b\.xlsx/);
});
