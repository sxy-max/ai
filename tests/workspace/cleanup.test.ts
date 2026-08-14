/** WP17 测试：workspace 清理调度（active 排除 + artifact 独立持久化）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager } from "../../lib/workspace/service";
import { artifactService } from "../../lib/artifacts/service";

process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-artifacts-cleanup-test");
const WS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "goai-ws-cleanup-"));

test("cleanupExpired：active 任务 workspace 排除；过期删除", () => {
  // 过期 workspace（createdAt 很久以前）
  const oldWs = new WorkspaceManager(path.join(WS_ROOT, "tasks", "old-task")).createWorkspace();
  const metaPath = path.join(oldWs.root, "workspace.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.createdAt = Date.now() - 10 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(metaPath, JSON.stringify(meta));

  // active 任务 workspace（新 + 在 exclude 集合）
  const activeWs = new WorkspaceManager(path.join(WS_ROOT, "tasks", "active-task")).createWorkspace();
  fs.writeFileSync(path.join(activeWs.root, "working", "keep.txt"), "keep");

  const removed = WorkspaceManager.cleanupExpired(WS_ROOT, 7 * 24 * 60 * 60 * 1000, Date.now(), new Set(["active-task"]));
  assert.equal(removed, 1, "只清理过期且非 active 的 workspace");
  assert.equal(fs.existsSync(path.join(WS_ROOT, "tasks", "old-task")), false, "过期 workspace 已删");
  assert.equal(fs.existsSync(path.join(WS_ROOT, "tasks", "active-task", "working", "keep.txt")), true, "active 保留");
});

test("artifact 独立持久化：workspace 清理后 artifact 仍可下载", () => {
  const ws = new WorkspaceManager(path.join(WS_ROOT, "tasks", "art-task")).createWorkspace();
  fs.writeFileSync(path.join(ws.root, "output", "result.md"), "# 结果");

  // 注册为 artifact（独立存储）
  const artifact = artifactService.createArtifact({ filename: "result.md", content: "# 结果", kind: "markdown", source: "agent" });

  // 清理 workspace
  WorkspaceManager.cleanupExpired(WS_ROOT, 0, Date.now(), new Set());

  // artifact 仍在
  const buf = artifactService.readContent(artifact.id);
  assert.equal(buf?.toString("utf8"), "# 结果", "artifact 独立于 workspace 持久化");
});
