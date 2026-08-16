/**
 * V1.5 Phase A：真实 agent_workspace 任务完全由 AgentScope 2.0 Harness 驱动。
 * 链路：devExecutor → AgentScopeRuntimeAdapter（openai_credential + opencode-go 通道）
 *       → AgentScope server（loop/工具/workspace）→ output 回传 → completion contract。
 * 需要本地 agentscope server（scripts/agentscope-server.py，PORT=8011）与 redis。
 */
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-artifacts-v15");
process.env.AGENTSCOPE_URL = "http://127.0.0.1:8011";
process.env.AGENTSCOPE_BASE_URL = "https://opencode.ai/zen/go/v1";
process.env.AGENTSCOPE_MODEL = "deepseek-v4-flash";
process.env.WORKSPACES_ROOT = path.join(os.tmpdir(), "goai-ws-v15");
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../lib/db/users";
import { closeDb, query } from "../lib/db/pool";
import { closeRedis } from "../lib/db/redis";
import { runDevStep } from "../lib/tasks/devExecutor";
import { listTaskArtifacts } from "../lib/tasks/artifacts";
import { AgentScopeRuntimeAdapter } from "../lib/sandbox/agentscopeRuntime";

let userId = "";

test("V1.5 Phase A：AgentScope 驱动写 markdown 任务 → 真实产物 + 契约通过", async () => {
  // 服务器验收开关：本地 opencode 通道 40s 断连（Clash TUN）不适合跑真实模型任务；
  // 服务器（无代理限制）设置 RUN_V15_PHASE_A=1 跑真实验收
  if (process.env.RUN_V15_PHASE_A !== "1") {
    console.log("SKIP：RUN_V15_PHASE_A=1 时在服务器跑真实模型验收（本地 opencode 通道有 40s 断连限制）");
    return;
  }
  // 环境就绪检查：agentscope server 必须可达
  let probe: Response;
  try {
    probe = await fetch("http://127.0.0.1:8011/health", { headers: { "X-User-ID": "v15-test" }, signal: AbortSignal.timeout(3000) });
  } catch {
    console.log("SKIP：本地 agentscope server 未运行（python scripts/agentscope-server.py，PORT=8011）");
    return;
  }
  if (!probe.ok) {
    console.log("SKIP：agentscope server 健康检查失败");
    return;
  }
  const adapter = new AgentScopeRuntimeAdapter();
  assert.equal(adapter.available, true);

  const user = await createUser({ email: `v15-${Date.now()}@test.local`, displayName: "v15", password: "password-123" });
  userId = user.id;
  const task = (await query("INSERT INTO tasks (user_id, title, goal, type, status) VALUES ($1,'v15','把任务说明整理成 markdown 文件写入 output/','agent_workspace','queued') RETURNING id", [user.id])).rows[0].id;

  const wsRoot = process.env.WORKSPACES_ROOT as string;
  fs.mkdirSync(path.join(wsRoot, "tasks", String(task), "task"), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, "tasks", String(task), "task", "task.md"), "# 任务\n\n请写一份关于拉格朗日量的简介 markdown 到 output/。");

  const outcome = await runDevStep({
    taskId: String(task), stepId: "s", userId: user.id, projectId: null,
    goal: "把任务说明整理成 markdown 文件写入 output/",
    files: [], signal: new AbortController().signal, emit: async () => {},
  }, { adapter, workspacesRoot: wsRoot });

  console.log("devStep summary:", outcome.summary);
  const artifacts = await listTaskArtifacts(String(task));
  assert.ok(artifacts.length >= 1, `应产出至少 1 个产物（got ${artifacts.map((a) => a.name)}）`);
  const md = artifacts.find((a) => a.type === "markdown" || a.name.endsWith("md"));
  assert.ok(md, "应有 markdown 产物");
  assert.ok(md.size > 50, `产物非空（${md.size}B）`);
  console.log(`PASS：AgentScope 驱动任务产出 ${md.name}（${md.size}B）`);
});
