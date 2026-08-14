/** WP9 测试：FilePreprocessor（FileContext 结构化输出）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { preprocessFile, preprocessFiles, detectType } from "../../lib/files/preprocess";

test("detectType：按扩展名与 mime 分类", () => {
  assert.equal(detectType("a.md", "text/markdown"), "markdown");
  assert.equal(detectType("a.csv", "text/csv"), "csv");
  assert.equal(detectType("a.json", "application/json"), "json");
  assert.equal(detectType("a.html", "text/html"), "html");
  assert.equal(detectType("a.zip", "application/zip"), "zip");
  assert.equal(detectType("a.png", "image/png"), "image");
  assert.equal(detectType("a.py", "text/x-python"), "code");
  assert.equal(detectType("a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "other");
});

test("CSV：columns/rowCount/sampleRows", async () => {
  const ctx = await preprocessFile(Buffer.from("name,value\nA,1\nB,2\nC,3"), "data.csv", "text/csv");
  assert.equal(ctx.type, "csv");
  const s = ctx.structure as { columns: string[]; rowCount: number; sampleRows: string[][] };
  assert.deepEqual(s.columns, ["name", "value"]);
  assert.equal(s.rowCount, 3);
  assert.equal(s.sampleRows.length, 3);
});

test("HTML：title/headings/links/style/script", async () => {
  const ctx = await preprocessFile(Buffer.from(
    "<html><head><title>测试页</title><style>body{}</style></head><body><h1>标题</h1><a href='/x'>链接</a><script>let a=1</script></body></html>"
  ), "index.html", "text/html");
  const s = ctx.structure as { title: string; headings: string[]; hasStyle: boolean; hasScript: boolean };
  assert.equal(s.title, "测试页");
  assert.ok(s.headings.includes("标题"));
  assert.equal(s.hasStyle, true);
  assert.equal(s.hasScript, true);
});

test("ZIP：fileTree 提取", async () => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("src/index.html", "<html>v1</html>");
  zip.file("README.md", "# readme");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const ctx = await preprocessFile(Buffer.from(buf), "project.zip", "application/zip");
  assert.equal(ctx.type, "zip");
  const s = ctx.structure as { fileTree: string[]; entryCount: number };
  assert.ok(s.fileTree.includes("src/index.html"));
  assert.equal(s.entryCount >= 2, true);
});

test("JSON：keys/arrayLength 摘要；坏 JSON 标注", async () => {
  const ok = await preprocessFile(Buffer.from('{"a":1,"b":2}'), "data.json", "application/json");
  assert.deepEqual((ok.structure as { keys: string[] }).keys, ["a", "b"]);
  const bad = await preprocessFile(Buffer.from("{bad json"), "data.json", "application/json");
  assert.match(String((bad.structure as { error?: string }).error || ""), /解析失败/);
});

test("markdown：headings 提取；image：占位说明", async () => {
  const md = await preprocessFile(Buffer.from("# 标题\n\n## 小节\n\n内容"), "doc.md", "text/markdown");
  assert.ok((md.structure as { headings: string[] }).headings.length >= 2);
  const img = await preprocessFile(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "ref.png", "image/png");
  assert.equal(img.type, "image");
  assert.match(String((img.structure as { note?: string }).note || ""), /VisionPreprocessor/);
});

test("preprocessFiles：批量容错", async () => {
  const contexts = await preprocessFiles([
    { filename: "a.csv", mime: "text/csv", content: Buffer.from("x,y\n1,2") },
    { filename: "b.md", mime: "text/markdown", content: Buffer.from("# B") }
  ]);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].type, "csv");
  assert.equal(contexts[1].type, "markdown");
});
