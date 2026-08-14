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

  async prepare(): Promise<RuntimePrepareResult> {
    return this.failPrepare ? { ok: false, error: "fake runtime 不可用" } : { ok: true, detail: "fake 就绪" };
  }

  async execute(request: SandboxRunRequest, onEvent: (event: SandboxRunEvent) => void | Promise<void>): Promise<SandboxRunResult> {
    const taskId = request.job.jobId.replace("task-", "");
    const root = path.join(WORKSPACES_ROOT, "tasks", taskId);
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
  const result = await runDevStep(
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
  );
  // 中间步骤无产物不再失败（任务级校验在 worker 完成阶段）
  assert.match(result.summary, /无产物交付/);
});
