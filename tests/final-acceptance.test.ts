/**
 * 综合验收（本 Goal §44 的本地链路版）：真实网站 ZIP + 参考 UI 截图 + CSV 数据 + Markdown 需求
 * → Preflight → 任务系统 → Claude Code 主 Harness（fake adapter 模拟容器契约）→ 产物 → Validation。
 * 真实模型/视觉/浏览器在云端矩阵验收（scripts/cloud-final.mjs）。
 */

import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
delete process.env.OPENCODE_GO_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createUser, findUserByEmail } from "../lib/db/users";
import { query, closeDb } from "../lib/db/pool";
import { closeRedis } from "../lib/db/redis";
import { artifactService } from "../lib/artifacts/service";

process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-final-artifacts");
process.env.WORKSPACES_ROOT = path.join(os.tmpdir(), "goai-final-ws");

let repo: typeof import("../lib/tasks/repo");
let worker: typeof import("../lib/tasks/worker");
let projects: typeof import("../lib/projects/api");

before(async () => {
  [repo, worker, projects] = await Promise.all([
    import("../lib/tasks/repo"),
    import("../lib/tasks/worker"),
    import("../lib/projects/api"),
  ]);
  const { setAdapterOverride } = await import("../lib/sandbox/adapterOverride");
  const { FakeClaudeCodeAdapter } = await import("../lib/sandbox/fakeAdapter");
  setAdapterOverride(new FakeClaudeCodeAdapter(process.env.WORKSPACES_ROOT));
});

after(async () => {
  const { setAdapterOverride } = await import("../lib/sandbox/adapterOverride");
  setAdapterOverride(null);
  await closeDb();
  await closeRedis();
});

async function testUser(tag: string) {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  let user = await findUserByEmail(email);
  if (!user) user = await createUser({ email, displayName: tag, password: "password-123" });
  return user;
}

/** 构造综合验收材料：网站 ZIP + 参考图 + CSV + 需求文档。 */
async function buildFixtures(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  // 1. 网站 ZIP（index.html + style.css + app.js）
  const siteDir = path.join(dir, "site");
  fs.mkdirSync(path.join(siteDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(siteDir, "index.html"), "<!doctype html><html><head><title>旧站点</title><link rel='stylesheet' href='assets/style.css'></head><body><h1>Old Site</h1><p>旧内容</p></body></html>");
  fs.writeFileSync(path.join(siteDir, "assets", "style.css"), "body { background: #fff; }");
  fs.writeFileSync(path.join(siteDir, "assets", "app.js"), "console.log('old');");
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  for (const f of ["index.html", "assets/style.css", "assets/app.js"]) {
    zip.file(f, fs.readFileSync(path.join(siteDir, f)));
  }
  const siteZip = await zip.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(path.join(dir, "site.zip"), siteZip);
  // 2. 参考 UI 截图（简单 PNG：用最小合法 PNG 头+像素）
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(path.join(dir, "reference.png"), png);
  // 3. CSV 数据
  fs.writeFileSync(path.join(dir, "data.csv"), "产品,销量,地区\n手机,120,华东\n电脑,85,华北\n平板,60,华南\n");
  // 4. Markdown 需求
  fs.writeFileSync(path.join(dir, "requirements.md"), "# 网站重构需求\n\n- 按参考图重构首页视觉\n- 整合 data.csv 数据展示销量表\n- 保证移动端无横向滚动\n- 完成后打包为 zip\n");
  return { siteZip, png };
}

test("综合验收：网站 ZIP + 参考图 + CSV + 需求 → 项目任务完整链路", async () => {
  const user = await testUser("final-accept");
  const fixtures = path.join(os.tmpdir(), "goai-final-fixtures");
  const files = await buildFixtures(fixtures);

  // 建项目（持久 workspace）
  const projectRow = await query("INSERT INTO projects (user_id, name, description, status) VALUES ($1, '综合验收项目', '重构网站', 'active') RETURNING id", [user.id]);
  const projectId = String(projectRow.rows[0].id);

  // 上传 4 个附件
  const attachmentIds: string[] = [];
  for (const name of ["site.zip", "reference.png", "data.csv", "requirements.md"]) {
    const art = await artifactService.createArtifact({ filename: name, content: fs.readFileSync(path.join(fixtures, name)), kind: "unknown", source: "upload" });
    attachmentIds.push(art.id);
    await query("INSERT INTO files (user_id, task_id, filename, storage_key, size, mime) VALUES ($1, NULL, $2, $3, $4, $5)", [user.id, name, art.id, fs.statSync(path.join(fixtures, name)).size, "application/octet-stream"]);
  }

  // 任务（goal = 综合要求）
  const goal = "根据参考图重构网站页面，整合 data.csv 的销量数据，保证移动端适配，完成后打包为 zip";
  const task = await repo.createTask({ userId: user.id, projectId, goal, title: "综合重构" });
  // 绑定附件到任务
  const frows = await query("SELECT id FROM files WHERE user_id = $1 AND task_id IS NULL ORDER BY id DESC LIMIT 4", [user.id]);
  for (const r of frows.rows) {
    await query("UPDATE files SET task_id = $1 WHERE id = $2", [task.id, r.id]);
  }

  const signal = new AbortController().signal;
  await worker.runTaskToEnd(task.id, signal);

  const done = await repo.getTask(task.id);
  assert.equal(done?.status, "completed", `任务应完成（实际 ${done?.status}：${done?.error || ""}）`);
  assert.ok(done?.plan?.length, "应有 plan");

  // 产物 ≥1 且已注册
  const { listTaskArtifacts } = await import("../lib/tasks/artifacts");
  const artifacts = await listTaskArtifacts(task.id);
  assert.ok(artifacts.length >= 1, `至少 1 个产物（实际 ${artifacts.length}）`);

  // workspace 有文件变化（项目持久根）
  const wsRoot = path.join(process.env.WORKSPACES_ROOT!, "projects", projectId);
  const outputDir = path.join(wsRoot, "output");
  assert.ok(fs.existsSync(outputDir), "项目 workspace output/ 应存在");
  const outputs = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
  assert.ok(outputs.length >= 1, `output/ 应有交付文件（实际 ${outputs.join(",")}）`);

  // 事件流含 agent 执行轨迹
  const events = await repo.listTaskEvents(task.id);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("agent.started"), "应有 agent.started");
  assert.ok(types.includes("agent.completed"), "应有 agent.completed");

  // 项目详情 API 数据面（产物历史 + 文件树）
  const project = await projects.getProject(user.id, projectId);
  assert.ok(project, "项目应存在");
  const projectArts = await projects.projectArtifacts(user.id, projectId);
  assert.ok(projectArts.length >= 1, "项目产物历史应含交付物");

  void files;
  void attachmentIds;
});

test("综合验收：directive 判定（zip+图片+csv+需求 → 完整能力面）", async () => {
  const { buildDirective } = await import("../lib/preflight/build");
  const d = await buildDirective({
    goal: "根据参考图重构网站页面，整合 data.csv 的销量数据，保证移动端适配，完成后打包为 zip",
    attachments: [
      { kind: "archive", mime: "application/zip", name: "site.zip" },
      { kind: "image", mime: "image/png", name: "reference.png" },
      { kind: "spreadsheet", mime: "text/csv", name: "data.csv" },
      { kind: "file", mime: "text/markdown", name: "requirements.md" },
    ],
  });
  assert.ok(d.capabilities.includes("coding"));
  assert.ok(d.capabilities.includes("vision"), "参考图 → vision 能力");
  assert.ok(d.capabilities.includes("spreadsheet"), "CSV → spreadsheet 能力");
  assert.equal(d.workspaceMode, "task");
  assert.equal(d.mainModel, "deepseek-v4-flash");
  assert.equal(d.deliveryContract.validate, "format");
  assert.equal(d.deliveryContract.mustChangeFiles, true);
});
