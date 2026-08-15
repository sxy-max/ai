/** WP2 测试：TaskExecutionPlan 映射 + /api/chat 任务型防线。 */
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
// 测试隔离：删除模型 key，防止测试进程发起真实网络请求（慢/不可控）
delete process.env.OPENCODE_GO_API_KEY; delete process.env.DEEPSEEK_API_KEY;
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { buildExecutionPlan } from "../../lib/tasks/executionPlan";
import { closeDb } from "../../lib/db/pool";
import { closeRedis } from "../../lib/db/redis";
import { POST as chatPost } from "../../app/api/chat/route";

after(async () => {
  await closeDb();
  await closeRedis();
});

test("executionPlan：artifact 任务 → artifact_generation/content 角色", () => {
  const plan = buildExecutionPlan({ id: "t1", type: "artifact", goal: "根据旋转圆环小珠问题生成两页 PPT" }, []);
  assert.equal(plan.taskType, "artifact_generation");
  assert.equal(plan.executor, "artifact");
  assert.equal(plan.modelRole, "content");
  assert.deepEqual(plan.expectedArtifacts, ["pptx"]);
  assert.equal(plan.needsWorkspace, false);
});

test("executionPlan：agent_workspace + 图片 → vision_file_transform（needsVision）", () => {
  const plan = buildExecutionPlan(
    { id: "t2", type: "agent_workspace", goal: "按照图片修改网页" },
    [{ filename: "reference.png" }, { filename: "index.html" }]
  );
  assert.equal(plan.taskType, "vision_file_transform");
  assert.equal(plan.executor, "workspace");
  assert.equal(plan.modelRole, "agent");
  assert.equal(plan.needsVision, true);
  assert.equal(plan.needsWorkspace, true);
  assert.ok(plan.capabilities.includes("vision"));
});

test("executionPlan：agent_workspace + ZIP → project_agent", () => {
  const plan = buildExecutionPlan(
    { id: "t3", type: "agent_workspace", goal: "处理这个项目压缩包" },
    [{ filename: "project.zip" }]
  );
  assert.equal(plan.taskType, "project_agent");
  assert.ok(plan.expectedArtifacts.includes("zip"));
});

test("executionPlan：agent_workspace + 普通文件 → file_transform；无文件 → workspace_agent", () => {
  const withFile = buildExecutionPlan({ id: "t4", type: "agent_workspace", goal: "整理这个文档" }, [{ filename: "材料.md" }]);
  assert.equal(withFile.taskType, "file_transform");
  const bare = buildExecutionPlan({ id: "t5", type: "agent_workspace", goal: "搭建一个项目" }, []);
  assert.equal(bare.taskType, "workspace_agent");
});

function authedChat(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-access-password": process.env.ACCESS_PASSWORD || "" },
    body: JSON.stringify(body)
  });
}

test("chat 防线：任务型请求被 422 拒绝（TASK_ROUTE_REQUIRED）", async () => {
  const res = await chatPost(authedChat({
    provider: "opencode-go",
    model: "mock-code",
    modelToken: "x",
    messages: [{ role: "user", content: "帮我生成一个 PPT" }]
  }));
  assert.equal(res.status, 422);
  assert.equal(res.headers.get("x-task-route-required"), "true");
});

test("chat 防线：普通问答不受影响（放行）", async () => {
  const res = await chatPost(authedChat({
    provider: "opencode-go",
    model: "mock-code",
    modelToken: "x",
    messages: [{ role: "user", content: "解释一下什么是光合作用" }]
  }));
  // 防线放行（后续因 mock model token 校验失败 → 403 也证明没被 422 拦截；这里断言非 422）
  assert.notEqual(res.status, 422);
});

