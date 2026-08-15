/** Workspace Manifest / Snapshot / Ingestion 测试（V1.3 WP14-17）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWorkspaceManifest, writeWorkspaceManifest, readWorkspaceManifest, manifestSummary, fileChangedSince } from "../../lib/workspace/manifest";
import { createWorkspaceSnapshot, restoreWorkspaceSnapshot, listWorkspaceSnapshots, cleanupWorkspaceSnapshots } from "../../lib/workspace/snapshot";
import { ingestFileBuffer, ingestZipArchive, descriptorsSummary, typeOf } from "../../lib/files/ingestion";
import * as XLSX from "xlsx";
import JSZip from "jszip";

function wsFixture(tag: string): string {
  const dir = path.join(os.tmpdir(), `goai-ws-${tag}-${Date.now()}`);
  fs.mkdirSync(path.join(dir, "input"), { recursive: true });
  fs.mkdirSync(path.join(dir, "working"), { recursive: true });
  fs.mkdirSync(path.join(dir, "output"), { recursive: true });
  fs.writeFileSync(path.join(dir, "input", "note.md"), "# 标题\n\n内容\n");
  fs.writeFileSync(path.join(dir, "working", "page.html"), "<html><body>旧</body></html>");
  return dir;
}

test("WP15 manifest：role 分区 + sha256 + 摘要", () => {
  const root = wsFixture("manifest");
  const manifest = buildWorkspaceManifest(root);
  writeWorkspaceManifest(root, manifest);
  const read = readWorkspaceManifest(root);
  assert.ok(read);
  assert.equal(read?.files.length, 2);
  const note = read?.files.find((f) => f.path === "input/note.md");
  assert.equal(note?.role, "input");
  assert.match(note?.sha256 || "", /^[0-9a-f]{64}$/);
  const html = read?.files.find((f) => f.path === "working/page.html");
  assert.equal(html?.role, "working");
  assert.equal(html?.mime, "text/html");

  const summary = manifestSummary(read);
  assert.match(summary, /input\/: note\.md/);
  assert.match(summary, /working\/: page\.html/);

  assert.equal(fileChangedSince(root, "input/note.md", read), false);
  fs.writeFileSync(path.join(root, "input", "note.md"), "# 改了");
  assert.equal(fileChangedSince(root, "input/note.md", read), true, "修改后 sha256 变化应被检测");
});

test("WP14 snapshot：创建/列出/还原（rollback step）", () => {
  const root = wsFixture("snapshot");
  const snap = createWorkspaceSnapshot(root, "before-repair");
  assert.ok(snap);
  assert.equal(snap?.files.length, 1, "working 有一个文件");

  // Agent 改坏
  fs.writeFileSync(path.join(root, "working", "page.html"), "<html>损坏内容!!!</html>");
  const restored = restoreWorkspaceSnapshot(root, snap!.id);
  assert.equal(restored, 1);
  assert.match(fs.readFileSync(path.join(root, "working", "page.html"), "utf8"), /旧/, "restore 应还原干净版本");

  const snaps = listWorkspaceSnapshots(root);
  assert.equal(snaps.length, 1);
  cleanupWorkspaceSnapshots(root);
  assert.equal(listWorkspaceSnapshots(root).length, 0);
});

test("WP16 ingestion：文本/图片/xlsx/zip 描述符", () => {
  const md = ingestFileBuffer("note.md", Buffer.from("# 标题\n\n正文", "utf8"));
  assert.equal(md.type, "markdown");
  assert.match(md.extractedText || "", /标题/);

  const img = ingestFileBuffer("shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  assert.equal(img.type, "image");
  assert.equal(img.visionContext, true);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"], ["1", "2"]]), "S");
  const xlsx = ingestFileBuffer("data.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
  assert.equal(xlsx.type, "xlsx");

  assert.equal(typeOf("archive.zip"), "zip");
  assert.equal(typeOf("page.html"), "html");
  assert.equal(typeOf("script.py"), "other");
});

test("WP17 ZIP workspace：归档清单（3 文件项目）", async () => {
  const zip = new JSZip();
  zip.file("index.html", "<html>首页</html>");
  zip.file("style.css", "body{}");
  zip.file("app.js", "console.log(1)");
  const buf = await zip.generateAsync({ type: "nodebuffer" }) as Buffer;
  const descriptor = await ingestZipArchive(buf);
  assert.ok(descriptor);
  assert.equal(descriptor?.type, "zip");
  assert.equal(descriptor?.archiveManifest?.length, 3);
  assert.ok(descriptor?.archiveManifest?.includes("index.html"));

  const summary = descriptorsSummary([descriptor!]);
  assert.match(summary, /归档：3 个文件/);
});

test("WP17 ZIP workspace：zip slip 被拒（解压失败标记）", async () => {
  // 构造含 ../ 条目的 zip（JSZip 允许；safeExtractZip 应拒绝）
  const zip = new JSZip();
  zip.file("../escape.txt", "bad");
  const buf = await zip.generateAsync({ type: "nodebuffer" }) as Buffer;
  const descriptor = await ingestZipArchive(buf);
  assert.ok(descriptor);
  assert.ok(!descriptor!.archiveManifest?.includes("../escape.txt"), "zip slip 条目不得进入清单");
});
