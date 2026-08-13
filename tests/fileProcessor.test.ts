import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager } from "../lib/workspace/service";
import {
  detectFileKind,
  MANIFEST_RELPATH,
  readWorkspaceManifest,
  registerWorkspaceManifest,
} from "../lib/files/processor";

function makeWs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "go-ai-fp-"));
  const ws = new WorkspaceManager(root).createWorkspace();
  return { ws, root };
}

test("1. detectFileKind：按扩展名分类", () => {
  assert.equal(detectFileKind("a.csv"), "csv");
  assert.equal(detectFileKind("b.json"), "json");
  assert.equal(detectFileKind("c.html"), "html");
  assert.equal(detectFileKind("d.md"), "markdown");
  assert.equal(detectFileKind("e.js"), "js");
  assert.equal(detectFileKind("f.png"), "image");
  assert.equal(detectFileKind("g.zip"), "zip");
  assert.equal(detectFileKind("h.txt"), "text");
  assert.equal(detectFileKind("i.unknown"), "text");
  assert.equal(detectFileKind("j.pdf"), "binary");
  assert.equal(detectFileKind("UPPER.CSV"), "csv");
});

test("2. registerWorkspaceManifest：登记 input/output 文件，排除内部元数据", () => {
  const { ws } = makeWs();
  ws.writeInputFile("index.html", "<h1>hi</h1>");
  ws.writeInputFile("data.csv", "a,b\n1,2");
  fs.writeFileSync(path.join(ws.dirs.output, "result.md"), "# done");
  const manifest = registerWorkspaceManifest(ws);

  assert.equal(manifest.version, 1);
  assert.equal(manifest.files.length, 3);
  const byRel = Object.fromEntries(manifest.files.map((f) => [f.relPath, f]));
  assert.equal(byRel["input/index.html"].kind, "html");
  assert.equal(byRel["input/data.csv"].kind, "csv");
  assert.equal(byRel["output/result.md"].kind, "markdown");
  assert.equal(byRel["input/index.html"].area, "input");

  const onDisk = JSON.parse(fs.readFileSync(path.join(ws.root, MANIFEST_RELPATH), "utf8"));
  assert.equal(onDisk.files.length, 3);
  const hasInternal = onDisk.files.some((f: { relPath: string }) => f.relPath.startsWith(".go-ai") || f.relPath === "workspace.json");
  assert.equal(hasInternal, false);
});

test("3. readWorkspaceManifest：回读与重写后刷新", () => {
  const { ws } = makeWs();
  assert.equal(readWorkspaceManifest(ws), null);
  ws.writeInputFile("a.txt", "x");
  const m1 = registerWorkspaceManifest(ws);
  assert.equal(readWorkspaceManifest(ws)?.files.length, 1);
  ws.writeInputFile("b.txt", "y");
  const m2 = registerWorkspaceManifest(ws);
  assert.equal(m2.files.length, 2);
  assert.ok(m2.updatedAt >= m1.updatedAt);
});
