/** WP12 测试：Artifact Validator（HTML/CSV/JSON/ZIP/PPTX/MD）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { artifactService } from "../../lib/artifacts/service";
import { validateArtifactFormat } from "../../lib/artifacts/validator";

process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-artifacts-validator-test");

function put(filename: string, content: string | Buffer) {
  const a = artifactService.createArtifact({ filename, content, kind: "markdown", source: "upload" });
  return a.id;
}

test("HTML：合法通过，缺结构失败", async () => {
  const ok = await validateArtifactFormat(put("page.html", "<html><body><h1>标题</h1></body></html>"), "page.html", "html");
  assert.equal(ok?.ok, true);
  const bad = await validateArtifactFormat(put("bad.html", "纯文本没有标签"), "bad.html", "html");
  assert.equal(bad?.ok, false);
  assert.match(bad?.error || "", /结构/);
});

test("CSV：可解析且列数一致；列不一致失败", async () => {
  const ok = await validateArtifactFormat(put("d.csv", "a,b\n1,2\n3,4"), "d.csv", "csv");
  assert.equal(ok?.ok, true);
  const bad = await validateArtifactFormat(put("bad.csv", "a,b\n1,2,3"), "bad.csv", "csv");
  assert.equal(bad?.ok, false);
  assert.match(bad?.error || "", /列数/);
});

test("JSON：parse 成功/失败", async () => {
  const ok = await validateArtifactFormat(put("d.json", '{"a":1}'), "d.json", "json");
  assert.equal(ok?.ok, true);
  const bad = await validateArtifactFormat(put("bad.json", "{oops"), "bad.json", "json");
  assert.equal(bad?.ok, false);
});

test("ZIP：可解压且无 traversal；空 zip 失败", async () => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("src/a.txt", "x");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const ok = await validateArtifactFormat(put("p.zip", Buffer.from(buf)), "p.zip", "zip");
  assert.equal(ok?.ok, true);

  const empty = new JSZip();
  const emptyBuf = await empty.generateAsync({ type: "nodebuffer" });
  const bad = await validateArtifactFormat(put("e.zip", Buffer.from(emptyBuf)), "e.zip", "zip");
  assert.equal(bad?.ok, false);
  assert.match(bad?.error || "", /无有效文件/);
});

test("PPTX：zip 容器 + Content_Types + presentation.xml + slide>0；纯 zip 失败", async () => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("ppt/presentation.xml", "<presentation/>");
  zip.file("ppt/slides/slide1.xml", "<slide/>");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const ok = await validateArtifactFormat(put("d.pptx", Buffer.from(buf)), "d.pptx", "pptx");
  assert.equal(ok?.ok, true);

  const fake = new JSZip();
  fake.file("hello.txt", "not a pptx");
  const fakeBuf = await fake.generateAsync({ type: "nodebuffer" });
  const bad = await validateArtifactFormat(put("fake.pptx", Buffer.from(fakeBuf)), "fake.pptx", "pptx");
  assert.equal(bad?.ok, false);
});

test("markdown：非空即合格；空失败", async () => {
  const ok = await validateArtifactFormat(put("d.md", "# 标题\n内容"), "d.md", "markdown");
  assert.equal(ok?.ok, true);
  const empty = await validateArtifactFormat(put("e.md", ""), "e.md", "markdown");
  assert.equal(empty?.ok, false);
  assert.match(empty?.error || "", /为空/);
});
