import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactService } from "../lib/artifacts/service";
import { mimeFromFilename, mimeFromKind, kindFromFilename } from "../lib/artifacts/mime";
import { sanitizeFilename, defaultFilename, computeExpiry, isExpired, normalizeArtifact } from "../lib/artifacts/metadata";
import { transformContent } from "../lib/artifacts/transform";

function makeService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "go-ai-art-"));
  return { service: new ArtifactService(root), root };
}

function htmlDoc(lines: number): string {
  const arr: string[] = [];
  for (let i = 0; i < lines; i++) arr.push(`<div id="line${i}">${i}</div>`);
  return arr.join("\n");
}

test("1. 创建 html artifact → 落盘 + manifest 含完整元数据", () => {
  const { service, root } = makeService();
  const a = service.createArtifact({ filename: "webpage.html", content: "<h1>hi</h1>", kind: "html", source: "chat", messageId: "m1" });
  assert.equal(a.kind, "html");
  assert.equal(a.filename, "webpage.html");
  assert.equal(a.status, "ready");
  assert.equal(a.source, "chat");
  assert.equal(a.messageId, "m1");
  assert.ok(fs.existsSync(path.join(root, a.id)));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.ok(manifest[a.id]);
  assert.equal(manifest[a.id].filename, "webpage.html");
  assert.equal(service.readContent(a.id)?.toString("utf8"), "<h1>hi</h1>");
});

test("2. markdown / csv artifact → kind 与 mime 由文件名推导", () => {
  const { service } = makeService();
  const md = service.createArtifact({ filename: "notes.md", content: "# title" });
  assert.equal(md.kind, "markdown");
  assert.equal(md.mimeType, "text/markdown");
  const csv = service.createArtifact({ filename: "data.csv", content: "a,b\n1,2" });
  assert.equal(csv.kind, "csv");
  assert.equal(csv.mimeType, "text/csv");
});

test("3. mimeType 推导：mimeFromKind / mimeFromFilename", () => {
  assert.equal(mimeFromKind("pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  assert.equal(mimeFromKind("zip"), "application/zip");
  assert.equal(mimeFromKind("unknown"), "application/octet-stream");
  assert.equal(mimeFromFilename("index.html"), "text/html");
  assert.equal(mimeFromFilename("app.js"), "text/javascript");
  assert.equal(mimeFromFilename("noext"), "application/octet-stream");
});

test("4. filename 推导：sanitizeFilename / defaultFilename", () => {
  assert.equal(sanitizeFilename("../..//webpage.html"), "webpage.html");
  assert.equal(sanitizeFilename('a b"c<d>.html'), "a_b_c_d_.html");
  assert.equal(sanitizeFilename(""), "file");
  assert.equal(defaultFilename("html"), "document.html");
  assert.equal(defaultFilename("pptx"), "slides.pptx");
  assert.equal(defaultFilename("unknown"), "file.txt");
});

test("5. 序列化给前端：只含元数据，不含完整内容", () => {
  const { service } = makeService();
  const a = service.createArtifact({ filename: "data.json", content: '{"k":"v"}', kind: "json", source: "artifact_task", jobId: "job-1" });
  const c = service.serializeArtifactForClient(a);
  assert.equal(c.id, a.id);
  assert.equal(c.kind, "json");
  assert.equal(c.name, "data.json");
  assert.equal(c.mime, "application/json");
  assert.equal(c.size, a.size);
  assert.equal(c.status, "ready");
  assert.ok(c.downloadUrl.includes(a.id));
  assert.ok(!("content" in c), "client artifact 不应包含完整 content");
});

test("6. 旧 manifest 条目兼容：normalizeArtifact 推导 kind/status/source", () => {
  const legacy = normalizeArtifact("legacy-1", { name: "old.html", mime: "text/html", size: 100, createdAt: 1700000000000 });
  assert.equal(legacy.id, "legacy-1");
  assert.equal(legacy.kind, "html");
  assert.equal(legacy.status, "ready");
  assert.equal(legacy.source, "manual_upload");
  assert.equal(legacy.filename, "old.html");
  assert.equal(legacy.mimeType, "text/html");
});

test("7. 过期状态：markArtifactExpired / computeExpiry / isExpired", () => {
  const { service } = makeService();
  const a = service.createArtifact({ filename: "a.txt", content: "x", ttlMs: 1000 });
  assert.equal(a.expiresAt, a.createdAt + 1000);
  assert.equal(computeExpiry(a.createdAt, undefined), undefined);
  const marked = service.markArtifactExpired(a.id);
  assert.equal(marked?.status, "expired");
  assert.equal(service.getArtifact(a.id)?.status, "expired");
  assert.equal(isExpired({ expiresAt: Date.now() - 1 }), true);
  assert.equal(isExpired({ expiresAt: Date.now() + 100000 }), false);
});

test("8. jobId / messageId 绑定：listArtifactsForJob / listArtifactsForMessage", () => {
  const { service } = makeService();
  service.createArtifact({ filename: "f1.html", content: "a", kind: "html", source: "file_agent", jobId: "job-x" });
  service.createArtifact({ filename: "f2.md", content: "b", source: "file_agent", jobId: "job-x" });
  service.createArtifact({ filename: "f3.txt", content: "c", source: "chat", messageId: "msg-y" });
  const jobs = service.listArtifactsForJob("job-x");
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((a) => a.jobId === "job-x"));
  const msgs = service.listArtifactsForMessage("msg-y");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].filename, "f3.txt");
});

test("9. HTML>100 transformContent → Artifact Service：消息体无完整代码、artifact 内容完整", () => {
  const { service } = makeService();
  const raw = "```html\n" + htmlDoc(150) + "\n```";
  const res = transformContent(raw, false);
  assert.equal(res.requests.length, 1);
  assert.equal(res.requests[0].kind, "html");
  assert.equal(res.requests[0].filename, "webpage.html");
  assert.ok(res.content.includes("HTML 已生成，共 150 行，已转为文件。"), "消息体应替换为摘要");
  assert.ok(!res.content.includes('<div id="line149">'), "消息体不应含完整代码");
  assert.ok(res.content.includes('<div id="line0">'), "消息体应含前 15 行预览");
  const a = service.createArtifact({ filename: res.requests[0].filename, content: res.requests[0].content, kind: res.requests[0].kind, source: "chat" });
  assert.equal(a.kind, "html");
  const stored = service.readContent(a.id)?.toString("utf8") || "";
  assert.ok(stored.includes('<div id="line149">'), "artifact 内容应完整存储");
  const client = service.serializeArtifactForClient(a);
  assert.ok(!("content" in client), "Message 侧只保存 artifact 元数据");
});

test("10. 明确文件请求 artifact 化：explicit 超长代码块 → code artifact；非 explicit 不转", () => {
  const { service } = makeService();
  const lines = Array.from({ length: 120 }, (_, i) => `// line ${i}`).join("\n");
  const raw = "代码在下面：\n\n```js\n" + lines + "\n```";
  assert.equal(transformContent(raw, false).requests.length, 0, "非 explicit 时超长代码块不转 artifact");
  const res = transformContent(raw, true);
  assert.equal(res.requests.length, 1);
  assert.equal(res.requests[0].kind, "code");
  assert.equal(res.requests[0].filename, "code-1.js");
  assert.equal(res.requests[0].mime, "text/javascript");
  assert.ok(res.content.includes("代码已生成，共 120 行，已转为文件。"));
  const a = service.createArtifact({ filename: res.requests[0].filename, content: res.requests[0].content, kind: res.requests[0].kind });
  assert.equal(a.kind, "code");
  assert.ok((service.readContent(a.id)?.toString("utf8") || "").includes("// line 119"));
});

test("11. 明确文件请求：explicit 短 HTML → 也转 artifact（区别于 30 行非 explicit）", () => {
  const short = "```html\n<h1>hi</h1>\n```";
  assert.equal(transformContent(short, false).requests.length, 0);
  const res = transformContent(short, true);
  assert.equal(res.requests.length, 1);
  assert.equal(res.requests[0].kind, "html");
  assert.equal(res.requests[0].filename, "webpage.html");
});

test("12. deleteArtifact 删除落盘文件与 manifest 条目", () => {
  const { service, root } = makeService();
  const a = service.createArtifact({ filename: "tmp.txt", content: "x" });
  assert.ok(fs.existsSync(path.join(root, a.id)));
  assert.equal(service.deleteArtifact(a.id), true);
  assert.equal(service.getArtifact(a.id), null);
  assert.ok(!fs.existsSync(path.join(root, a.id)));
  assert.equal(service.deleteArtifact(a.id), false);
});
