// 诊断：fake adapter 下任务闭环失败原因
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
delete process.env.OPENCODE_GO_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
process.env.ARTIFACTS_ROOT = "C:/Users/SXY/AppData/Local/Temp/goai-diag-artifacts";
process.env.WORKSPACES_ROOT = "C:/Users/SXY/AppData/Local/Temp/goai-diag-ws";

const { createUser, findUserByEmail } = await import("../lib/db/users");
const repo = await import("../lib/tasks/repo");
const worker = await import("../lib/tasks/worker");
const { setAdapterOverride } = await import("../lib/sandbox/adapterOverride");
const { FakeClaudeCodeAdapter } = await import("../lib/sandbox/fakeAdapter");
setAdapterOverride(new FakeClaudeCodeAdapter(process.env.WORKSPACES_ROOT));

const email = "diag-" + Date.now() + "@test.local";
let user = await findUserByEmail(email);
if (!user) user = await createUser({ email, displayName: "diag", password: "password-123" });
const task = await repo.createTask({ userId: user.id, goal: "整理一份销售数据表格" });
await worker.runTaskToEnd(task.id, new AbortController().signal);
const done = await repo.getTask(task.id);
console.log("STATUS:", done?.status, "| ERROR:", done?.error);
const steps = await repo.getSteps(task.id);
console.log("STEPS:", steps.map((s) => `${s.worker_type}:${s.status}${s.error ? " ERR=" + s.error : ""}`).join(" | "));
const { closeDb } = await import("../lib/db/pool");
await closeDb();
// 追加诊断（临时）
const { query } = await import("../lib/db/pool");
const arts = await query("SELECT id, name, type, status FROM artifacts WHERE task_id = $1", [task.id]);
console.log("PG ARTIFACTS:", JSON.stringify(arts.rows));
const fs = await import("node:fs");
const wsRoot = process.env.WORKSPACES_ROOT + "/tasks/" + task.id;
console.log("WS EXISTS:", fs.existsSync(wsRoot), "| WS ROOT:", wsRoot);
if (fs.existsSync(wsRoot)) {
  const walk = (d, depth = 0) => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      console.log("  ".repeat(depth) + e.name + (e.isDirectory() ? "/" : ""));
      if (e.isDirectory()) walk(d + "/" + e.name, depth + 1);
    }
  };
  walk(wsRoot);
}

await closeDb();
process.exit(0);
