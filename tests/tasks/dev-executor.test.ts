/** Dev 执行器测试（WP3/WP4 接线）：fake Claude Code runtime → workspace 编排 → PG 产物注册。 */
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../../lib/db/users";
import { query, closeDb } from "../../lib/db/pool";
import { closeRedis } from "../../lib/db/redis";
import { artifactService } from "../../lib/artifacts/service";
import type { AgentRuntimeAdapter, RuntimePrepareResult, SandboxRunEvent, SandboxRunRequest, SandboxRunResult } from "../../lib/sandbox/adapter";

process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-artifacts-dev-executor-test");
const WORKSPACES_ROOT = path.join(os.tmpdir(), "goai-workspaces-dev-executor-test");

/** Fake Claude Code runtime：模拟容器事件流 + 在 output/ 产出文件。 */
class FakeClaudeCodeRuntime implements AgentRuntimeAdapter {
  readonly id = "fake-claude-code";
  readonly available = true;
  failPrepare = false;
  failOutput = false;
  /** 模拟图片任务"只分析不交付"：第一次执行输出分析文本但不产文件。 */
  failFirstOutput = false;
  /** 记录每次 execute 收到的 prompt（断言视觉摘要/修复指令用）。 */
  prompts: string[] = [];
  private callCount = 0;

  async prepare(): Promise<RuntimePrepareResult> {
    return this.failPrepare ? { ok: false, error: "fake runtime 不可用" } : { ok: true, detail: "fake 就绪" };
  }

  async execute(request: SandboxRunRequest, onEvent: (event: SandboxRunEvent) => void | Promise<void>): Promise<SandboxRunResult> {
    this.prompts.push(request.prompt);
    this.callCount++;
    const taskId = request.job.jobId.replace("task-", "");
    const root = path.join(WORKSPACES_ROOT, "tasks", taskId);
    if (this.failFirstOutput && this.callCount === 1) {
      // 只分析不交付：输出分析文本，不产出文件
      await onEvent({ type: "tool", name: "Read", detail: "读取参考图描述" });
      await onEvent({ type: "text", text: "分析：该页面应改为深色科技风卡片布局…" });
      await onEvent({ type: "done", exitCode: 0 });
      return { ok: true, exitCode: 0 };
    }
    await onEvent({ type: "tool", name: "Read", detail: "读取 input" });
    await onEvent({ type: "tool", name: "Write", detail: "修改文件" });
    await onEvent({ type: "text", text: "正在处理…" });
    // agent 产出到 output/
    const outputDir = path.join(root, "output");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "result.md"), "# 处理结果\n\n已完成修改。\n");
    await onEvent({ type: "artifacts", files: [{ name: "output/result.md" }] });
    await onEvent({ type: "done", exitCode: 0, durationMs: 42 });
    return { ok: true, exitCode: 0, durationMs: 42 };
  }

  async collectOutputs(workspaceRoot: string): Promise<Array<{ relPath: string; absPath: string; size: number; isDir: boolean }>> {
    const out: Array<{ relPath: string; absPath: string; size: number; isDir: boolean }> = [];
    for (const dir of ["output", "artifacts"]) {
      const abs = path.join(workspaceRoot, dir);
      if (!fs.existsSync(abs)) continue;
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        out.push({ relPath: `${dir}/${entry.name}`, absPath: path.join(abs, entry.name), size: entry.isFile() ? fs.statSync(path.join(abs, entry.name)).size : 0, isDir: entry.isDirectory() });
      }
    }
    return out;
  }
  async cancel(): Promise<void> {}
  async cleanup(): Promise<void> {}
}

let userId = "";
let runDevStep: typeof import("../../lib/tasks/devExecutor").runDevStep;

before(async () => {
  const user = await createUser({ email: `dev-exec-${Date.now()}@test.local`, displayName: "dev-exec", password: "password-123" });
  userId = user.id;
  const mod = await import("../../lib/tasks/devExecutor");
  runDevStep = mod.runDevStep;
});

after(async () => {
  await closeDb();
  await closeRedis();
});

test("dev 步骤：workspace 编排 → 文件入 input → task spec → 产物注册 PG → 事件", async () => {
  const task = await query<{ id: string }>(
    `INSERT INTO tasks (user_id, goal, type, title, status) VALUES ($1, '根据图片修改 HTML', 'agent_workspace', '工作区测试', 'queued') RETURNING id`,
    [userId]
  );
  const taskId = task.rows[0].id;

  // 用户文件（进 artifactService 存储，模拟上传）
  const uploaded = artifactService.createArtifact({ filename: "index.html", content: "<html><body>旧页面</body></html>", kind: "html", source: "upload" });

  const events: string[] = [];
  const runtime = new FakeClaudeCodeRuntime();
  const summary = await runDevStep(
    {
      taskId,
      stepId: "step-1",
      userId,
      goal: "把 input/index.html 的背景改成蓝色",
      files: [{ id: uploaded.id, filename: "index.html" }],
      signal: new AbortController().signal,
      emit: async (type: string, payload?: Record<string, unknown>) => { events.push(`${type}:${payload?.stage || payload?.name || ""}`); }
    },
    { adapter: runtime, workspacesRoot: WORKSPACES_ROOT }
  );

  // 1. workspace 目录结构（WP4 契约）
  const wsRoot = path.join(WORKSPACES_ROOT, "tasks", taskId);
  for (const dir of ["task", "input", "vision", "working", "output", "artifacts", "logs"]) {
    assert.equal(fs.existsSync(path.join(wsRoot, dir)), true, `缺少目录 ${dir}`);
  }

  // 2. 用户文件进 input/
  const inputFile = fs.readFileSync(path.join(wsRoot, "input", "index.html"), "utf8");
  assert.match(inputFile, /旧页面/);

  // 3. task spec + context.json
  assert.equal(fs.existsSync(path.join(wsRoot, "task", "task.json")), true);
  assert.equal(fs.existsSync(path.join(wsRoot, "task", "task.md")), true);
  assert.equal(fs.existsSync(path.join(wsRoot, "task", "context.json")), true);
  const context = JSON.parse(fs.readFileSync(path.join(wsRoot, "task", "context.json"), "utf8"));
  assert.match(context.prompt, /背景改成蓝色/);
  assert.equal(context.outputContract.includes("output/"), true);

  // 4. 产物注册 PG（归属 + 版本化）
  const artifacts = await query<{ id: string; type: string; name: string; version: number; user_id: string }>(
    "SELECT id, type, name, version, user_id FROM artifacts WHERE task_id = $1", [taskId]
  );
  assert.equal(artifacts.rows.length, 1, "应注册 1 个产物");
  assert.equal(artifacts.rows[0].type, "markdown");
  assert.equal(artifacts.rows[0].version, 1);
  assert.equal(artifacts.rows[0].user_id, userId);

  // 5. 事件流
  assert.ok(events.some((e) => e.startsWith("agent.started")), "应有 agent.started");
  assert.ok(events.some((e) => e.startsWith("tool.started")), "应有 tool 事件");
  assert.ok(events.some((e) => e.startsWith("artifact.created")), "应有 artifact.created");

  // 6. summary
  assert.match(summary.summary, /1 个文件/);
});

test("dev 步骤：runtime 不可用 → 明确错误（DEV_RUNTIME_UNAVAILABLE）", async () => {
  const task = await query<{ id: string }>(
    `INSERT INTO tasks (user_id, goal, type, title, status) VALUES ($1, '测试', 'agent_workspace', 'runtime 失败', 'queued') RETURNING id`,
    [userId]
  );
  const runtime = new FakeClaudeCodeRuntime();
  runtime.failPrepare = true;
  await assert.rejects(
    runDevStep(
      {
        taskId: task.rows[0].id,
        stepId: "step-1",
        userId,
        goal: "测试",
        files: [],
        signal: new AbortController().signal,
        emit: async () => {}
      },
      { adapter: runtime, workspacesRoot: WORKSPACES_ROOT }
    ),
    /DEV_RUNTIME_UNAVAILABLE/
  );
});

test("dev 步骤：无产物 → 明确错误（DEV_OUTPUT_EMPTY）", async () => {
  const task = await query<{ id: string }>(
    `INSERT INTO tasks (user_id, goal, type, title, status) VALUES ($1, '测试', 'agent_workspace', '无产物', 'queued') RETURNING id`,
    [userId]
  );
  const runtime = new FakeClaudeCodeRuntime();
  // 覆盖 execute：不产出文件，done 但无 artifacts
  runtime.execute = async (request, onEvent) => {
    await onEvent({ type: "done", exitCode: 0 });
    return { ok: true, exitCode: 0 };
  };
  // 无产物 → 纠错循环重试仍无产物 → 明确失败（有限次数，不无限循环）
  await assert.rejects(
    runDevStep(
      {
        taskId: task.rows[0].id,
        stepId: "step-1",
        userId,
        goal: "测试",
        files: [],
        signal: new AbortController().signal,
        emit: async () => {}
      },
      { adapter: runtime, workspacesRoot: WORKSPACES_ROOT }
    ),
    /TASK_CONTRACT_RETRYABLE/
  );
  // attempts 记录落盘
  const attemptsDir = path.join(WORKSPACES_ROOT, "tasks", task.rows[0].id, "agent", "attempts");
  const attemptFiles = fs.existsSync(attemptsDir) ? fs.readdirSync(attemptsDir) : [];
  assert.ok(attemptFiles.length >= 1, "应有 attempt 记录");
});

test("图片任务：视觉摘要内联进 prompt；首轮只分析不交付 → 自动修复轮交付", async () => {
  const task = await query<{ id: string }>(
    `INSERT INTO tasks (user_id, goal, type, title, status) VALUES ($1, '按截图修改页面', 'agent_workspace', '图片任务', 'queued') RETURNING id`,
    [userId]
  );
  const taskId = task.rows[0].id;

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2kS8AAAAASUVORK5CYII=", "base64");
  const uploadedImg = artifactService.createArtifact({ filename: "shot.png", content: png, kind: "image", source: "upload" });
  const uploadedHtml = artifactService.createArtifact({ filename: "index.html", content: "<html><body>旧页面</body></html>", kind: "html", source: "upload" });

  const runtime = new FakeClaudeCodeRuntime();
  runtime.failFirstOutput = true; // 首轮"只分析不交付"
  const summary = await runDevStep(
    {
      taskId,
      stepId: "step-1",
      userId,
      goal: "按截图修改页面：把 index.html 重做成截图中的深色卡片风格",
      files: [{ id: uploadedImg.id, filename: "shot.png" }, { id: uploadedHtml.id, filename: "index.html" }],
      signal: new AbortController().signal,
      emit: async () => {}
    },
    {
      adapter: runtime,
      workspacesRoot: WORKSPACES_ROOT,
      describeVision: async () => "summary：深色科技风页面，居中卡片\nlayout：单卡片居中\nvisible_text：Go AI 云工作台\ncolors：深蓝背景 #0b0f1a，蓝色主按钮 #3b82f6"
    }
  );

  const wsRoot = path.join(WORKSPACES_ROOT, "tasks", taskId);
  // 1. vision 落盘（新契约 vision/ + 旧容器兼容 .go-ai/vision/）
  assert.equal(fs.existsSync(path.join(wsRoot, "vision", "shot.md")), true, "vision/shot.md 应落盘");
  assert.equal(fs.existsSync(path.join(wsRoot, ".go-ai", "vision", "shot.md")), true, ".go-ai/vision/shot.md 应落盘（旧容器兼容）");

  // 2. 每次执行 prompt 都内联视觉摘要（系统侧代读，agent 无需先读 vision 文件）
  assert.ok(runtime.prompts.length >= 2, `应执行 2 次（首轮+修复轮），实际 ${runtime.prompts.length}`);
  for (const p of runtime.prompts) {
    assert.match(p, /\[参考图视觉摘要/, "prompt 应含视觉摘要");
    assert.match(p, /Go AI 云工作台/, "摘要内容应进入 prompt");
    assert.match(p, /UNTRUSTED/, "摘要必须标记 UNTRUSTED");
  }

  // 3. 修复轮 prompt = 修复指令 + 摘要（要求实际产出文件）
  assert.match(runtime.prompts[1], /任务尚未完成/, "修复轮应含修复指令");
  assert.match(runtime.prompts[1], /当前缺失/, "修复指令应列出缺失项");
  assert.match(runtime.prompts[1], /必须产出真实文件/, "修复指令应强调交付");

  // 4. 修复轮交付 → 任务完成
  assert.match(summary.summary, /1 个文件/);
  // 成功后不再重试：恰好 2 次 execute
  assert.equal(runtime.prompts.length, 2, "成功后不应继续重试");
});

test("图片任务：始终不交付 → 有限重试（3 次）→ 明确失败，attempts 全量落盘", async () => {
  const task = await query<{ id: string }>(
    `INSERT INTO tasks (user_id, goal, type, title, status) VALUES ($1, '按截图重做页面', 'agent_workspace', '图片任务失败', 'queued') RETURNING id`,
    [userId]
  );
  const taskId = task.rows[0].id;

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2kS8AAAAASUVORK5CYII=", "base64");
  const uploadedImg = artifactService.createArtifact({ filename: "shot.png", content: png, kind: "image", source: "upload" });

  const runtime = new FakeClaudeCodeRuntime();
  // 所有轮次都不产出（覆盖 execute 为纯分析）
  runtime.execute = async (request, onEvent) => {
    runtime.prompts.push(request.prompt);
    await onEvent({ type: "tool", name: "Read", detail: "读取参考图描述" });
    await onEvent({ type: "text", text: "分析：页面应该这样改…" });
    await onEvent({ type: "done", exitCode: 0 });
    return { ok: true, exitCode: 0 };
  };

  await assert.rejects(
    runDevStep(
      {
        taskId,
        stepId: "step-1",
        userId,
        goal: "按截图重做页面",
        files: [{ id: uploadedImg.id, filename: "shot.png" }],
        signal: new AbortController().signal,
        emit: async () => {}
      },
      {
        adapter: runtime,
        workspacesRoot: WORKSPACES_ROOT,
        describeVision: async () => "summary：深色卡片页面\nlayout：居中卡片"
      }
    ),
    /TASK_CONTRACT_RETRYABLE/
  );

  // 图片任务 maxAttempts=3：首轮 + 3 次修复 = 4 次 execute，attempt-1..3 落盘
  assert.equal(runtime.prompts.length, 4, `图片任务应尝试 4 次（1+3），实际 ${runtime.prompts.length}`);
  const attemptsDir = path.join(WORKSPACES_ROOT, "tasks", taskId, "agent", "attempts");
  const attemptFiles = fs.existsSync(attemptsDir) ? fs.readdirSync(attemptsDir).sort() : [];
  assert.deepEqual(attemptFiles, ["attempt-1.json", "attempt-2.json", "attempt-3.json"], "3 次修复尝试应全量落盘");
  for (const f of attemptFiles) {
    const record = JSON.parse(fs.readFileSync(path.join(attemptsDir, f), "utf8"));
    assert.equal(record.maxAttempts, 3);
    assert.ok(record.failureReason, "应有失败原因");
    assert.match(record.repairInstruction, /当前 Workspace 状态/);
  }
});
