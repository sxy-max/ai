import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager } from "../../lib/workspace/service";
import { scanWorkspaceVision } from "../../lib/vision/workspaceScanner";

const FAKE_DESC = [
  "summary：图片展示 Go AI 文件处理界面。",
  "visible_text：标题「文件处理」。",
  "layout：上方标题、中间主按钮。",
  "ui_elements：蓝色主按钮，位于中间。",
  "important_details：按钮显示「开始」。",
  "uncertainty：无。",
].join("\n");

function makeWs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "go-ai-vis-"));
  const ws = new WorkspaceManager(root).createWorkspace();
  return { ws, root };
}

test("1. 图片 + mock describe → 写 .md 与结构化 .json，visionMd=true", async () => {
  const { ws } = makeWs();
  ws.writeInputFile("shot.png", Buffer.from("fake-png-bytes"));
  const result = await scanWorkspaceVision(ws, "test-key", async () => FAKE_DESC);

  assert.equal(result.visionMd, true);
  assert.equal(result.scanned, 1);
  assert.equal(result.failures, 0);

  const vDir = path.join(ws.dirs.internal, "vision");
  const md = fs.readFileSync(path.join(vDir, "shot.md"), "utf8");
  assert.ok(md.includes("summary：图片展示 Go AI 文件处理界面。"));

  const json = JSON.parse(fs.readFileSync(path.join(vDir, "shot.json"), "utf8"));
  assert.equal(json.source, "input/shot.png");
  assert.ok(json.summary.includes("Go AI 文件处理界面"));
  assert.ok(json.ui_elements.includes("蓝色主按钮"));
});

test("2. describe 返回空串 → 降级：无落盘、visionMd=false、计入 failures", async () => {
  const { ws } = makeWs();
  ws.writeInputFile("a.png", Buffer.from("bytes"));
  const result = await scanWorkspaceVision(ws, "test-key", async () => "");

  assert.equal(result.visionMd, false);
  assert.equal(result.scanned, 0);
  assert.equal(result.failures, 1);
  assert.equal(fs.existsSync(path.join(ws.dirs.internal, "vision")), false);
});

test("3. describe 抛错 → 降级不中断，后续图片仍处理", async () => {
  const { ws } = makeWs();
  ws.writeInputFile("a.png", Buffer.from("a"));
  ws.writeInputFile("b.png", Buffer.from("b"));
  let calls = 0;
  const result = await scanWorkspaceVision(ws, "test-key", async () => {
    calls++;
    if (calls === 1) throw new Error("vision boom");
    return FAKE_DESC;
  });

  assert.equal(result.visionMd, true);
  assert.equal(result.scanned, 1);
  assert.equal(result.failures, 1);
  const vDir = path.join(ws.dirs.internal, "vision");
  const mds = fs.readdirSync(vDir).filter((f) => f.endsWith(".md"));
  assert.equal(mds.length, 1, "只有成功的图片落盘 .md");
});

test("4. 无图片 → 空结果，visionMd=false", async () => {
  const { ws } = makeWs();
  ws.writeInputFile("notes.txt", "no image");
  const result = await scanWorkspaceVision(ws, "test-key", async () => FAKE_DESC);
  assert.deepEqual(result, { visionMd: false, scanned: 0, failures: 0 });
});

test("5. 非图片文件不处理；.go-ai/ 内部不重复扫描", async () => {
  const { ws } = makeWs();
  ws.writeInputFile("logo.svg", "<svg/>");
  const result = await scanWorkspaceVision(ws, "test-key", async () => FAKE_DESC);
  assert.equal(result.scanned, 0);
  assert.equal(result.failures, 0);
});
