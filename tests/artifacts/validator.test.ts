/** WP12 测试：Artifact Validator（HTML/CSV/JSON/ZIP/PPTX/MD）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { ArtifactService } from "../../lib/artifacts/service";
import { LocalObjectStorage } from "../../lib/storage/objectStorage";
import { validateArtifactFormat } from "../../lib/artifacts/validator";

const service = new ArtifactService(path.join(os.tmpdir(), "goai-artifacts-validator-test"), new LocalObjectStorage(path.join(os.tmpdir(), "goai-artifacts-validator-test")));

function put(filename: string, content: string | Buffer) {
  const a = service.createArtifact({ filename, content, kind: "markdown", source: "upload" });
  return { id: a.id, buf: Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8") };
}

test("HTML：合法通过，缺结构失败", async () => {
  const ok = await validateArtifactFormat(put("page.html", "<html><body><h1>标题</h1></body></html>").id, "page.html", "html", put("page.html", "<html><body><h1>标题</h1></body></html>").buf);
  assert.equal(ok?.ok, true);
  const bad = await validateArtifactFormat(put("bad.html", "纯文本没有标签").id, "bad.html", "html", put("bad.html", "纯文本没有标签").buf);
  assert.equal(bad?.ok, false);
  assert.match(bad?.error || "", /结构/);
});

test("CSV：可解析且列数一致；列不一致失败", async () => {
  const ok = await validateArtifactFormat(put("d.csv", "a,b\n1,2\n3,4").id, "d.csv", "csv", put("d.csv", "a,b\n1,2\n3,4").buf);
  assert.equal(ok?.ok, true);
  const bad = await validateArtifactFormat(put("bad.csv", "a,b\n1,2,3").id, "bad.csv", "csv", put("bad.csv", "a,b\n1,2,3").buf);
  assert.equal(bad?.ok, false);
  assert.match(bad?.error || "", /列数/);
});

test("JSON：parse 成功/失败", async () => {
  const ok = await validateArtifactFormat(put("d.json", '{"a":1}').id, "d.json", "json", put("d.json", '{"a":1}').buf);
  assert.equal(ok?.ok, true);
  const bad = await validateArtifactFormat(put("bad.json", "{oops").id, "bad.json", "json", put("bad.json", "{oops").buf);
  assert.equal(bad?.ok, false);
});

test("ZIP：可解压且无 traversal；空 zip 失败", async () => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("src/a.txt", "x");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const ok = await validateArtifactFormat(put("p.zip", Buffer.from(buf)).id, "p.zip", "zip", Buffer.from(buf));
  assert.equal(ok?.ok, true);

  const empty = new JSZip();
  const emptyBuf = await empty.generateAsync({ type: "nodebuffer" });
  const bad = await validateArtifactFormat(put("e.zip", Buffer.from(emptyBuf)).id, "e.zip", "zip", Buffer.from(emptyBuf));
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
  const ok = await validateArtifactFormat(put("d.pptx", Buffer.from(buf)).id, "d.pptx", "pptx", Buffer.from(buf));
  assert.equal(ok?.ok, true);

  const fake = new JSZip();
  fake.file("hello.txt", "not a pptx");
  const fakeBuf = await fake.generateAsync({ type: "nodebuffer" });
  const bad = await validateArtifactFormat(put("fake.pptx", Buffer.from(fakeBuf)).id, "fake.pptx", "pptx", Buffer.from(fakeBuf));
  assert.equal(bad?.ok, false);
});

test("markdown：非空即合格；空失败", async () => {
  const ok = await validateArtifactFormat(put("d.md", "# 标题\n内容").id, "d.md", "markdown", put("d.md", "# 标题\n内容").buf);
  assert.equal(ok?.ok, true);
  const empty = await validateArtifactFormat(put("e.md", "").id, "e.md", "markdown", put("e.md", "").buf);
  assert.equal(empty?.ok, false);
  assert.match(empty?.error || "", /为空/);
});
