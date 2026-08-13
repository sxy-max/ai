import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import JSZip from "jszip";
import { WorkspaceManager } from "../lib/workspace/service";
import { safeExtractZip, safePackZip } from "../lib/workspace/zip";
import { resolveSafePath } from "../lib/workspace/safety";
import { WorkspaceError } from "../lib/workspace/types";

/** 手工构造 store 压缩 ZIP（允许任意 entry 名；JSZip.file("../x") 会自动清理掉 ../，无法用于 zip-slip 测试）。 */
function makeZipStore(entries: { name: string; content: string }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.content, "utf8");
    const crc = zlib.crc32(data) >>> 0;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt16LE(20, 4);
    l.writeUInt16LE(0x0800, 6);
    l.writeUInt16LE(0, 8);
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(data.length, 18);
    l.writeUInt32LE(data.length, 22);
    l.writeUInt16LE(name.length, 26);
    local.push(l, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x031e, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, eocd]);
}

function makeWs(limits?: ConstructorParameters<typeof WorkspaceManager>[1]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "go-ai-ws-"));
  const ws = new WorkspaceManager(root, limits).createWorkspace();
  return { ws, root };
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof WorkspaceError && e.code === code);
}

test("1. 创建 workspace → 目录结构 + metadata 落盘", () => {
  const { ws, root } = makeWs();
  for (const dir of ["input", "output", "artifacts", "task", ".go-ai"]) {
    assert.ok(fs.existsSync(path.join(root, dir)), `${dir} 应存在`);
    assert.ok(fs.statSync(path.join(root, dir)).isDirectory(), `${dir} 应为目录`);
  }
  const meta = JSON.parse(fs.readFileSync(path.join(root, "workspace.json"), "utf8"));
  assert.equal(meta.id, ws.id);
  assert.equal(meta.status, "ready");
  assert.equal(meta.limits.maxFiles, 200);
  assert.equal(ws.getMeta().root, root);
});

test("2. 写文件 → input/ 落盘且内容正确；读文件 → 返回 Buffer", () => {
  const { ws, root } = makeWs();
  const rel = ws.writeInputFile("notes.txt", "hello workspace");
  assert.equal(rel, "input/notes.txt");
  assert.equal(fs.readFileSync(path.join(root, "input", "notes.txt"), "utf8"), "hello workspace");
  assert.equal(ws.readWorkspaceFile("input/notes.txt")?.toString("utf8"), "hello workspace");
  assert.equal(ws.readWorkspaceFile("missing.txt"), null);
});

test("3. 写子目录文件（input/a/b.txt）", () => {
  const { ws, root } = makeWs();
  ws.writeInputFile("sub/nested.txt", "deep");
  assert.equal(fs.readFileSync(path.join(root, "input", "sub", "nested.txt"), "utf8"), "deep");
  assert.equal(ws.readWorkspaceFile("input/sub/nested.txt")?.toString("utf8"), "deep");
});

test("4. 写任务说明 → task/task.json + task/task.md", () => {
  const { ws, root } = makeWs();
  ws.writeTaskSpec({ title: "改网页", prompt: "把标题改成 Go AI", visionContext: "UNTRUSTED VISUAL CONTEXT 图片里有蓝色按钮", style: "简洁" });
  const j = JSON.parse(fs.readFileSync(path.join(root, "task", "task.json"), "utf8"));
  assert.equal(j.title, "改网页");
  assert.equal(j.prompt, "把标题改成 Go AI");
  assert.equal(ws.getMeta().taskSpec, "把标题改成 Go AI");
  const md = fs.readFileSync(path.join(root, "task", "task.md"), "utf8");
  assert.ok(md.includes("把标题改成 Go AI"));
  assert.ok(md.includes("视觉上下文"));
});

test("5. 路径穿越拒绝：../../ 逃逸 → path_traversal", () => {
  const { ws, root } = makeWs();
  expectCode(() => ws.writeInputFile("../../evil.txt", "x"), "path_traversal");
  expectCode(() => ws.writeInputFile("a/../../../evil.txt", "x"), "path_traversal");
  expectCode(() => ws.readWorkspaceFile("../outside.txt"), "path_traversal");
  assert.ok(!fs.existsSync(path.join(path.dirname(root), "evil.txt")), "不应写到 workspace 外");
  expectCode(() => resolveSafePath(root, "../../etc/passwd"), "path_traversal");
});

test("6. 绝对路径拒绝：/etc/passwd、C:\\\\x → absolute_path", () => {
  const { root } = makeWs();
  expectCode(() => resolveSafePath(root, "/etc/passwd"), "absolute_path");
  expectCode(() => resolveSafePath(root, "C:\\Users\\x\\y.txt"), "absolute_path");
  expectCode(() => resolveSafePath(root, "\\\\server\\share\\f"), "absolute_path");
});

test("7. .env 拒绝：任意层级 .env → env_reserved", () => {
  const { ws } = makeWs();
  expectCode(() => ws.writeInputFile(".env", "SECRET=1"), "env_reserved");
  expectCode(() => ws.writeInputFile("input/.env.local", "SECRET=1"), "env_reserved");
  expectCode(() => ws.writeInputFile("a/.env", "SECRET=1"), "env_reserved");
});

test("8. symlink 逃逸拒绝（junction 指向外部目录）", () => {
  const { ws, root } = makeWs();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "go-ai-out-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside-data");
  const link = path.join(root, "input", "link");
  try {
    fs.symlinkSync(outside, link, "junction");
  } catch {
    return; // 当前环境无 symlink 权限 → 跳过
  }
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "junction 应被识别为 symlink");
  expectCode(() => ws.readWorkspaceFile("input/link/secret.txt"), "symlink_escape");
  expectCode(() => ws.writeInputFile("link/new.txt", "x"), "symlink_escape");
  expectCode(() => ws.assertWorkspaceIntegrity(), "symlink_escape");
});

test("9. 单文件大小限制：超过 maxFileSize → file_too_large", () => {
  const { ws } = makeWs({ maxFileSize: 10 });
  ws.writeInputFile("ok.txt", "12345");
  expectCode(() => ws.writeInputFile("big.txt", "12345678901"), "file_too_large");
});

test("10. 总大小限制：累计超过 maxTotalSize → total_too_large", () => {
  const { ws } = makeWs({ maxTotalSize: 10 });
  ws.writeInputFile("a.txt", "123456");
  expectCode(() => ws.writeInputFile("b.txt", "123456"), "total_too_large");
  assert.ok(!fs.existsSync(path.join(ws.dirs.input, "b.txt")), "超限文件不应落盘");
});

test("11. 文件数量限制：超过 maxFiles → too_many_files", () => {
  const { ws } = makeWs({ maxFiles: 2 }); // 内部元数据不计入，用户文件上限为 2
  ws.writeInputFile("a.txt", "a");
  ws.writeInputFile("b.txt", "b");
  expectCode(() => ws.writeInputFile("c.txt", "c"), "too_many_files");
});

test("12. ZIP 安全解压：正常 zip → 文件落盘；zip-slip → 拒绝", async () => {
  const { ws, root } = makeWs();
  const zip = new JSZip();
  zip.file("a.txt", "hello");
  zip.file("docs/b.md", "# b");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const written = await safeExtractZip(buf, path.join(root, "input"), ws.limits);
  assert.ok(written.includes("a.txt"));
  assert.ok(written.includes("docs/b.md"));
  assert.equal(fs.readFileSync(path.join(root, "input", "a.txt"), "utf8"), "hello");

  // zip-slip：jszip 层会清理 ../ 路径段（正斜杠与反斜杠都会剥离），文件因此留在 workspace 内；
  // 我们的 resolveSafePath 兜底（test 5 已直接覆盖）。安全目标：任何情况下都不得逃逸到 workspace 外。
  const evil = makeZipStore([{ name: "../evil.txt", content: "pwn" }]);
  const evilWritten = await safeExtractZip(evil, path.join(root, "input"), ws.limits);
  assert.ok(!fs.existsSync(path.join(path.dirname(root), "evil.txt")), "zip-slip 不应逃逸落盘");
  assert.ok(evilWritten.every((p) => !p.includes("..")), "写入清单不应含逃逸路径");
});

test("13. ZIP 安全解压：zip bomb（解压后超限）→ zip_bomb，且不落盘", async () => {
  const { ws, root } = makeWs();
  const zip = new JSZip();
  zip.file("bomb.txt", "x".repeat(50_000));
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await assert.rejects(() => safeExtractZip(buf, path.join(root, "input"), { ...ws.limits, maxTotalSize: 1024 }), (e: unknown) => e instanceof WorkspaceError && e.code === "zip_bomb");
  assert.equal(fs.readdirSync(path.join(root, "input")).length, 0, "超限 zip 不应落盘任何文件");
});

test("14. ZIP 安全解压：symlink entry → 拒绝", async () => {
  const { ws, root } = makeWs();
  const zip = new JSZip();
  zip.file("a.txt", "ok");
  zip.file("link.txt", "/etc/passwd", { unixPermissions: 0o120777 });
  const buf = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
  await assert.rejects(() => safeExtractZip(buf, path.join(root, "input"), ws.limits), (e: unknown) => e instanceof WorkspaceError && e.code === "symlink_escape");
});

test("15. ZIP 重新打包：safePackZip → 解压回读内容一致", async () => {
  const { ws, root } = makeWs();
  ws.writeInputFile("report.md", "# 报告");
  ws.writeInputFile("data.csv", "a,b\n1,2");
  fs.writeFileSync(path.join(ws.dirs.output, "result.html"), "<h1>done</h1>");
  const buf = await safePackZip(root, { excludeInternal: true });
  const unzipped = await JSZip.loadAsync(buf);
  assert.equal(await unzipped.file("input/report.md")?.async("string"), "# 报告");
  assert.equal(await unzipped.file("input/data.csv")?.async("string"), "a,b\n1,2");
  assert.equal(await unzipped.file("output/result.html")?.async("string"), "<h1>done</h1>");
  assert.equal(unzipped.file("workspace.json"), null, "excludeInternal 应排除 workspace.json");
  assert.equal(unzipped.file(".go-ai/anything"), null);
});

test("16. collectOutputs → output/ + artifacts/ 产物完整收集", () => {
  const { ws } = makeWs();
  fs.writeFileSync(path.join(ws.dirs.output, "out.html"), "<h1>hi</h1>");
  fs.writeFileSync(path.join(ws.dirs.artifacts, "slides.pptx"), "pptx-bytes");
  const items = ws.collectOutputs();
  assert.equal(items.length, 2);
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(byName["out.html"].buffer.toString("utf8"), "<h1>hi</h1>");
  assert.equal(byName["slides.pptx"].buffer.toString("utf8"), "pptx-bytes");
  assert.equal(byName["out.html"].relPath, "out.html");
});

test("17. listWorkspaceFiles → 列出文件并标记区域", () => {
  const { ws } = makeWs();
  ws.writeInputFile("a.txt", "a");
  fs.writeFileSync(path.join(ws.dirs.output, "b.html"), "b");
  const files = ws.listWorkspaceFiles();
  const areas = Object.fromEntries(files.map((f) => [f.relPath, f.area]));
  assert.equal(areas["input/a.txt"], "input");
  assert.equal(areas["output/b.html"], "output");
  assert.equal(areas["workspace.json"], "internal");
});

test("18. cleanupWorkspace → 只删当前 workspace，父目录保留", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "go-ai-parent-"));
  const ws = new WorkspaceManager(path.join(parent, "ws")).createWorkspace();
  ws.writeInputFile("x.txt", "x");
  assert.ok(fs.existsSync(ws.root));
  ws.cleanupWorkspace();
  assert.ok(!fs.existsSync(ws.root), "workspace 根应被删除");
  assert.ok(fs.existsSync(parent), "父目录应保留");
  assert.equal(fs.readdirSync(parent).length, 0);
});

test("19. cleanupExpired → 只删过期 workspace，保留新目录与非 workspace", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "go-ai-ttl-"));
  const conv = path.join(parent, "conv1");
  fs.mkdirSync(conv, { recursive: true });

  // 过期 workspace：createdAt 设到过去
  const old = new WorkspaceManager(path.join(conv, "old")).createWorkspace();
  fs.writeFileSync(path.join(old.root, "workspace.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(old.root, "workspace.json"), "utf8")), createdAt: 1000 }));
  old.writeInputFile("x.txt", "x");

  // 新 workspace：createdAt 现在
  const fresh = new WorkspaceManager(path.join(conv, "fresh")).createWorkspace();
  fresh.writeInputFile("y.txt", "y");

  // 非 workspace 目录（无 workspace.json）：不应被清理
  fs.mkdirSync(path.join(conv, "junk"));
  fs.writeFileSync(path.join(conv, "junk", "keep.txt"), "keep");

  const removed = WorkspaceManager.cleanupExpired(parent, 60_000);
  assert.equal(removed, 1);
  assert.ok(!fs.existsSync(old.root), "过期 workspace 应被清理");
  assert.ok(fs.existsSync(fresh.root), "新 workspace 应保留");
  assert.ok(fs.existsSync(path.join(conv, "junk", "keep.txt")), "非 workspace 目录应保留");

  // TTL 设为无穷大 → 不再清理任何
  const removed2 = WorkspaceManager.cleanupExpired(parent, 10 ** 12);
  assert.equal(removed2, 0);
});
