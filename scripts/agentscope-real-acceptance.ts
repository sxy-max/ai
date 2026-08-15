// 临时验收（V1.2 WP8）：AgentScopeRuntimeAdapter 真实执行（MD/CSV/图片+HTML）
// 前置：AgentScope server 运行于 18010（WORKSPACES_ROOT=D:\Projects\go-ai\.data\agentscope-ws）
// 运行：npx tsx scripts/tmp-agentscope-real.ts
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}

async function main() {
  // 环境必须在 import 业务代码前设置（模块级常量读取）
  process.env.WORKSPACES_ROOT = "D:\\Projects\\go-ai\\.data\\agentscope-ws";
  process.env.AGENTSCOPE_URL = "http://127.0.0.1:18010";
  process.env.AGENTSCOPE_USER_ID = "go-ai";
  process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:18020"; // 本地 mock LLM（真实 AgentScope + 可控模型通道）
  process.env.AGENTSCOPE_MODEL = "deepseek-v4-flash";
  process.env.ARTIFACTS_ROOT = path.join(process.cwd(), ".data", "artifacts-real");

  const { createUser } = await import("../lib/db/users");
  const { query, closeDb } = await import("../lib/db/pool");
  const { closeRedis } = await import("../lib/db/redis");
  const { artifactService } = await import("../lib/artifacts/service");
  const { runDevStep } = await import("../lib/tasks/devExecutor");
  const { planExecutionPolicy } = await import("../lib/policy/executionPolicy");

  const WS_ROOT = process.env.WORKSPACES_ROOT;

  const policyFor = (vision: boolean): ReturnType<typeof planExecutionPolicy> =>
    planExecutionPolicy({
      requirements: {
        requiredCapabilities: [],
        reasoningNeeded: "auto",
        visionNeeded: vision,
        workspaceNeeded: true,
        toolsNeeded: true,
        artifactKinds: ["file"],
        taskType: vision ? "vision_file_transform" : "file_transform",
      },
      availableRuntimes: ["deterministic", "agentscope"], // 模拟无 Claude Code 环境：engine 应降级到 AgentScope
    });

  async function runCase(name: string, goal: string, files: Array<{ filename: string; content: Buffer }>) {
    const user = await createUser({ email: `as-real-${Date.now()}@test.local`, displayName: "as-real", password: "password-123" });
    const task = await query<{ id: string }>(
      `INSERT INTO tasks (user_id, goal, type, title, status) VALUES ($1, $2, 'agent_workspace', $3, 'queued') RETURNING id`,
      [user.id, goal, name]
    );
    const taskId = task.rows[0].id;
    const uploads = files.map((f) => {
      const a = artifactService.createArtifact({ filename: f.filename, content: f.content, kind: "txt", source: "upload" });
      return { id: a.id, filename: f.filename };
    });
    const events: string[] = [];
    const started = Date.now();
    const summary = await runDevStep(
      {
        taskId,
        stepId: "step-1",
        userId: user.id,
        goal,
        files: uploads,
        signal: new AbortController().signal,
        emit: async (type: string) => { events.push(type); },
      },
      {
        workspacesRoot: WS_ROOT,
        policy: policyFor(files.some((f) => /\.(png|jpe?g)$/i.test(f.filename))),
      }
    );
    const elapsed = Date.now() - started;
    const artifacts = await query<{ id: string; type: string; name: string; version: number }>(
      "SELECT id, type, name, version FROM artifacts WHERE task_id = $1", [taskId]
    );
    const wsRoot = path.join(WS_ROOT, "tasks", taskId);
    const outputFiles = fs.existsSync(path.join(wsRoot, "output")) ? fs.readdirSync(path.join(wsRoot, "output")) : [];
    const runtimeJson = fs.existsSync(path.join(wsRoot, "agent", "runtime.json"))
      ? JSON.parse(fs.readFileSync(path.join(wsRoot, "agent", "runtime.json"), "utf8"))
      : null;
    console.log(`\n=== ${name}（${elapsed}ms）===
goal: ${goal}
summary: ${summary.summary}
事件: ${events.join(" → ")}
产物(PG): ${JSON.stringify(artifacts.rows)}
output/ 文件: ${outputFiles.join(", ") || "（无）"}
runtime.json.adapterId: ${runtimeJson?.adapterId}（runtime: ${runtimeJson?.policy?.runtime}）`);
    return { taskId, artifacts: artifacts.rows, outputFiles };
  }

  try {
    // A. MD：分析 → 修改 → 输出新 MD
    await runCase("A-MD", "把 note.md 的内容整理成结构化文章（标题+分节），输出 markdown 文件到 output/", [
      { filename: "note.md", content: Buffer.from("# 会议纪要\n\n讨论了 Q3 目标：\n- 提升转化率\n- 降低流失\n- 发布新功能\n", "utf8") },
    ]);

    // B. CSV：删除重复行并按第二列排序
    await runCase("B-CSV", "读取 data.csv，删除重复行并按第二列（数值）升序排序，输出新 CSV 到 output/", [
      { filename: "data.csv", content: Buffer.from("name,score\nalice,30\nbob,10\nalice,30\ncarol,20\n", "utf8") },
    ]);

    // C. 图片 + HTML：按截图修改页面（真实 MiniMax vision 预处理）
    const img = fs.readFileSync(path.join(process.cwd(), "scripts", "fixtures", "vision", "reference.png"));
    await runCase("C-IMG-HTML", "按 reference.png 截图重做 index.html 的样式（深色卡片+蓝色按钮+三个功能卡片），修改后输出到 output/", [
      { filename: "reference.png", content: img },
      { filename: "index.html", content: Buffer.from('<html><body><h1>旧页面</h1><p>旧内容</p></body></html>', "utf8") },
    ]);
  } catch (error) {
    console.error("验收失败：", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await closeDb();
    await closeRedis();
    process.exit(process.exitCode || 0); // 显式退出（避免连接关闭挂起假象）
  }
}

void main();
