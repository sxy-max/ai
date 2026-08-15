/** ExecutionPolicyEngine + ModelPolicyEngine 测试（V1.2 WP3/WP4）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planExecutionPolicy, type ExecutionPolicyInput } from "../../lib/policy/executionPolicy";
import { selectModel, filterCapabilitySafe } from "../../lib/policy/modelPolicy";

function input(overrides: Partial<ExecutionPolicyInput["requirements"]>): ExecutionPolicyInput {
  return {
    requirements: {
      requiredCapabilities: [],
      reasoningNeeded: "auto",
      visionNeeded: false,
      workspaceNeeded: false,
      toolsNeeded: false,
      artifactKinds: [],
      taskType: "chat",
      ...overrides,
    },
  };
}

/* ---------- WP3 ExecutionPolicyEngine（deterministic-first） ---------- */

test("PPT 任务 → artifact + content 模型 + pptx generator（LLM 只做内容，不自己决定生成）", () => {
  const policy = planExecutionPolicy(input({ artifactKinds: ["pptx"], taskType: "artifact_generation" }));
  assert.equal(policy.executor, "artifact");
  assert.equal(policy.modelRole, "content");
  assert.equal(policy.artifactGenerator, "pptx");
  assert.equal(policy.runtime.runtime, "deterministic");
  assert.equal(policy.budget.tier, "artifact_planning");
});

test("ZIP 项目修改 → workspace + agent runtime（不退化成 chat）", () => {
  const policy = planExecutionPolicy(input({ workspaceNeeded: true, artifactKinds: ["zip", "file"], taskType: "project_agent", toolsNeeded: true }));
  assert.equal(policy.executor, "workspace");
  assert.equal(policy.modelRole, "agent");
  assert.equal(policy.runtime.runtime, "claude-code");
  assert.equal(policy.runtime.fallbackRuntimes[0], "agentscope");
  assert.equal(policy.tools.includes("archive.extract"), true);
  assert.equal(policy.tools.includes("archive.pack"), true);
  assert.equal(policy.retry.maxAttempts, 3);
});

test("图片+HTML → vision + workspace + agent（vision 预处理开启）", () => {
  const policy = planExecutionPolicy(input({ workspaceNeeded: true, visionNeeded: true, artifactKinds: ["file"], taskType: "vision_file_transform" }));
  assert.equal(policy.executor, "workspace");
  assert.equal(policy.visionPreprocessing, true);
  assert.equal(policy.tools.includes("vision.read_context"), true);
  assert.equal(policy.retry.maxAttempts, 3);
});

test("图片纯问答 → chat + vision（不进 Agent）", () => {
  const policy = planExecutionPolicy(input({ visionNeeded: true, taskType: "chat", requiredCapabilities: ["vision"] }));
  assert.equal(policy.executor, "chat");
  assert.equal(policy.modelRole, "chat");
  assert.equal(policy.visionPreprocessing, true);
});

test("CSV 明确转换 → artifact + deterministic（简单任务不用 Agent）", () => {
  const policy = planExecutionPolicy(input({ artifactKinds: ["csv"], taskType: "artifact_generation" }));
  assert.equal(policy.executor, "artifact");
  assert.equal(policy.artifactGenerator, "csv");
  assert.equal(policy.runtime.runtime, "deterministic");
});


test("V1.3 WP10：模型角色分离（planner/executor/vision 独立选择）", () => {
  const policy = planExecutionPolicy(input({ workspaceNeeded: true, visionNeeded: true, artifactKinds: ["file"], taskType: "vision_file_transform" }));
  assert.ok(policy.plannerModel, "应选 planner 模型");
  assert.ok(policy.executorModel, "应选 executor 模型");
  assert.ok(policy.visionModel, "应选 vision 模型");
  assert.ok(policy.executorModel !== policy.visionModel, "executor 与 vision 模型应不同");
  // 简单任务可相等（chat 无 workspace：不设 executorModel）
  const simple = planExecutionPolicy(input({ artifactKinds: ["pptx"], taskType: "artifact_generation" }));
  assert.equal(simple.executorModel, undefined);
});
test("FORCE_AGENTSCOPE=1：工作区任务优先 AgentScope（benchmark/验收开关）", () => {
  const old = process.env.FORCE_AGENTSCOPE;
  process.env.FORCE_AGENTSCOPE = "1";
  try {
    const policy = planExecutionPolicy(input({ workspaceNeeded: true, artifactKinds: ["file"], taskType: "file_transform" }));
    assert.equal(policy.runtime.runtime, "agentscope");
  } finally {
    if (old === undefined) delete process.env.FORCE_AGENTSCOPE; else process.env.FORCE_AGENTSCOPE = old;
  }
});

test("AgentScope 不可用（未在 availableRuntimes）→ 不选它", () => {
  const policy = planExecutionPolicy({
    ...input({ workspaceNeeded: true, artifactKinds: ["file"], taskType: "workspace_agent" }),
    availableRuntimes: ["claude-code"],
  });
  assert.equal(policy.runtime.runtime, "claude-code");
  assert.equal(policy.runtime.fallbackRuntimes[0], "agentscope");
});

test("简单文件任务 → 2 次修复尝试", () => {
  const policy = planExecutionPolicy(input({ workspaceNeeded: true, artifactKinds: ["file"], taskType: "file_transform" }));
  assert.equal(policy.retry.maxAttempts, 2);
});

/* ---------- WP4 ModelPolicyEngine ---------- */

test("普通问答 → 低成本稳定模型（flash 首选）", () => {
  const result = selectModel({ role: "chat" });
  assert.equal(result.model, "deepseek-v4-flash");
  assert.equal(result.fallbackTried.length, 0);
});

test("高难推理 → deepseek-v4-pro（reasoning model）", () => {
  const result = selectModel({ role: "reasoning" });
  assert.equal(result.model, "deepseek-v4-pro");
});

test("文件 Agent → flash（tool execution 优先，非长推理）", () => {
  const result = selectModel({ role: "agent" });
  assert.equal(result.model, "deepseek-v4-flash");
});

test("Vision → minimax-m3（视觉模型只负责观察）", () => {
  const result = selectModel({ role: "vision" });
  assert.equal(result.model, "minimax-m3");
});

test("capability-safe fallback：首选不可用 → 同角色降级链，不随机换模型", () => {
  const result = selectModel({ role: "reasoning", availableModels: ["glm-5.2", "deepseek-v4-flash"] });
  // 链：deepseek-v4-pro → qwen3.8-max → glm-5.2 → flash；glm-5.2 可用
  assert.equal(result.model, "glm-5.2");
  assert.ok(result.fallbackTried.includes("deepseek-v4-pro"));
});

test("能力过滤：需求 vision 时无 vision 模型列表 → 明确无可用（不硬选）", () => {
  const filtered = filterCapabilitySafe(["vision"], ["deepseek-v4-pro", "deepseek-v4-flash"]);
  assert.deepEqual(filtered, []);
  const result = selectModel({ role: "vision", availableModels: ["deepseek-v4-pro", "deepseek-v4-flash"], requiredCapabilities: ["vision"] });
  assert.equal(result.model, null);
  assert.match(result.reason, /no capable model/);
});

test("配置覆盖：AGENT_MODEL 环境变量优先于默认链", () => {
  const result = selectModel({ role: "agent", configured: { agent: "kimi-k3" } });
  assert.equal(result.model, "kimi-k3");
});
