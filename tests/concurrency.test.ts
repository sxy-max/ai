/** V1.4 WP52 并发真实测试：PPT/Browser Research/ZIP 项目 3 任务并行，workspace/产物互不污染。 */
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
delete process.env.OPENCODE_GO_API_KEY; delete process.env.DEEPSEEK_API_KEY;
import path from "node:path";
import os from "node:os";
process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-artifacts-concurrency");
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createUser } from "../lib/db/users";
import { closeDb, query } from "../lib/db/pool";
import { closeRedis } from "../lib/db/redis";
import { runDevStep } from "../lib/tasks/devExecutor";
import { listTaskArtifacts } from "../lib/tasks/artifacts";
import { artifactService } from "../lib/artifacts/service";
import type { AgentRuntimeAdapter } from "../lib/sandbox/adapter";

let userId = "";

before(async () => {
  const user = await createUser({ email: `conc-${Date.now()}@test.local`, displayName: "conc", password: "password-123" });
  userId = user.id;
});

after(async () => {
  await closeDb();
  await closeRedis();
});

async function makeTask(goal: string, projectId: string | null): Promise<string> {
  const row = await query(
    "INSERT INTO tasks (user_id, project_id, title, goal, type, status) VALUES ($1, $2, $3, $4, 'agent_workspace', 'queued') RETURNING id",
    [userId, projectId, goal.slice(0, 40), goal]
  );
  return String(row.rows[0].id);
}

/** 真实合法内容（格式验证会校验容器）：zip→jszip、pptx→generator、md→文本。 */
async function realContent(outputName: string): Promise<Buffer> {
  const { default: JSZip } = await import("jszip");
  if (outputName.endsWith(".zip")) return await new JSZip().file("index.html", "<h1>x</h1>").generateAsync({ type: "nodebuffer" }) as Buffer;
  if (outputName.endsWith(".pptx")) {
    const { PresentationGenerator } = await import("../lib/generators/presentationGenerator");
    return (await new PresentationGenerator().generate({ goal: "两页", spec: { title: "t", slides: [{ title: "一", sections: ["A"], layout: "title-content" }, { title: "二", sections: ["B"], layout: "title-content" }] } as never })).content;
  }
  return Buffer.from("# 报告\n\n内容", "utf8");
}

test("3 任务并发（PPT / Browser Research / ZIP 项目）：workspace 隔离 + 产物各自注册", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goai-conc-"));
  process.env.ENABLE_PROJECT_WS = "1";

  // 三个任务：两个普通（tasks/{id}）+ 一个项目（projects/{pid}）
  const project = (await query("INSERT INTO projects (user_id, name) VALUES ($1,'并发项目') RETURNING id", [userId])).rows[0].id;
  const taskPpt = await makeTask("做两页物理 PPT", null);
  const taskResearch = await makeTask("查三个网页信息整理报告", null);
  const taskZip = await makeTask("把网站背景改成深色", String(project));

  // 真实 zip 输入（格式验证）
  const { default: JSZip } = await import("jszip");
  const realZip = await new JSZip().file("index.html", "<h1>site</h1>").generateAsync({ type: "nodebuffer" }) as Buffer;
  const zipFileId = artifactService.createArtifact({ filename: "site.zip", content: realZip, kind: "zip", source: "upload" }).id;

  // 每个任务独立 fake adapter（模拟不同运行时），并发执行
  const results = await Promise.allSettled([
    runDevStep({ taskId: taskPpt, stepId: "s1", userId, projectId: null, goal: "做两页物理 PPT", files: [], signal: new AbortController().signal, emit: async () => {} }, {
      adapter: fakeAdapter(path.join(tmpRoot, "tasks", taskPpt), "slides.pptx"),
      workspacesRoot: tmpRoot,
    }),
    runDevStep({ taskId: taskResearch, stepId: "s2", userId, projectId: null, goal: "查资料写报告", files: [], signal: new AbortController().signal, emit: async () => {} }, {
      adapter: fakeAdapter(path.join(tmpRoot, "tasks", taskResearch), "research.md"),
      workspacesRoot: tmpRoot,
    }),
    runDevStep({ taskId: taskZip, stepId: "s3", userId, projectId: String(project), goal: "改背景", files: [{ id: zipFileId, filename: "site.zip" }], signal: new AbortController().signal, emit: async () => {} }, {
      adapter: fakeAdapter(path.join(tmpRoot, "projects", String(project)), "site-v2.zip"),
      workspacesRoot: tmpRoot,
    }),
  ]);

  for (const r of results) assert.equal(r.status, "fulfilled", `并发任务失败: ${r.status === "rejected" ? r.reason : ""}`);

  // 每个任务恰好 1 个自己的产物（互不污染）
  for (const [taskId, expectedName] of [[taskPpt, "slides"], [taskResearch, "research"], [taskZip, "site-v2"]] as const) {
    const artifacts = await listTaskArtifacts(taskId);
    assert.equal(artifacts.length, 1, `任务 ${taskId} 应有 1 个产物（got ${artifacts.map((a) => a.name)}）`);
    assert.equal(artifacts[0].name, expectedName);
  }

  // workspace 根各自独立
  assert.ok(fs.existsSync(path.join(tmpRoot, "tasks", taskPpt, "output", "slides.pptx")));
  assert.ok(fs.existsSync(path.join(tmpRoot, "tasks", taskResearch, "output", "research.md")));
  assert.ok(fs.existsSync(path.join(tmpRoot, "projects", String(project), "output", "site-v2.zip")));
  delete process.env.ENABLE_PROJECT_WS;
});

/** 生成固定输出文件的 fake adapter。 */
function fakeAdapter(wsRoot: string, outputName: string): AgentRuntimeAdapter {
  return {
    id: "fake", available: true,
    async prepare() { return { ok: true, detail: "ok" }; },
    async execute(_request, onEvent) {
      const outDir = path.join(wsRoot, "output");
      fs.mkdirSync(outDir, { recursive: true });
      const content = await realContent(outputName);
      fs.writeFileSync(path.join(outDir, outputName), content);
      await onEvent?.({ type: "artifacts", files: [{ name: `output/${outputName}`, mime: "application/octet-stream" }] } as never);
      await onEvent?.({ type: "done", exitCode: 0 } as never);
      return { ok: true, exitCode: 0, output: "done", artifactCount: 1 };
    },
    async collectOutputs() { return []; },
    async cancel() {}, async cleanup() {},
  };
}
