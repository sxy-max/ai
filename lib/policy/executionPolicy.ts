/**
 * ExecutionPolicyEngine（V1.2 WP3）：任务 → 执行策略（一等对象）。
 *
 * 输入：TaskRequirements + 可用模型/运行时/健康状态
 * 输出：ExecutionPolicy{ taskType, model, runtime, reasoningMode, maxOutputTokens,
 *        tools, visionPreprocessing, artifactGenerator, timeout, retry, fallback }
 *
 * 必须 deterministic-first：能用规则确定的，不调用 LLM 判断。
 *   - "制作 PPT" → artifact + pptx generator（LLM 只生成 PresentationSpec）
 *   - "修改 ZIP 项目" → agent_workspace + runtime（不退化成 chat）
 *   - "这张图里有什么" → vision + chat
 *   - "照这张图改 index.html" → vision + workspace + agent
 */

import { runtimeHasCapability, type RuntimeId } from "./capabilities";
import { budgetFor, type BudgetDecision, type BudgetTier } from "./tokenBudget";
import type { TaskRequirements } from "./capabilities";

export type RuntimeSelection = {
  runtime: RuntimeId;
  reason: string;
  /** 首选不可用时尝试的运行时（capability-safe）。 */
  fallbackRuntimes: RuntimeId[];
};

export type ExecutionPolicy = {
  taskType: string;
  /** 执行方式：chat / artifact / workspace。 */
  executor: "chat" | "artifact" | "workspace";
  /** 模型角色（ModelPolicyEngine 据此选模型）。 */
  modelRole: "chat" | "planner" | "content" | "agent" | "vision" | "reasoning";
  model?: string;
  /** V1.3 WP10：规划/执行/视觉/验证模型分离（简单任务可相等）。 */
  plannerModel?: string;
  executorModel?: string;
  visionModel?: string;
  validationModel?: string;
  runtime: RuntimeSelection;
  reasoningMode: "none" | "auto" | "high";
  budget: BudgetDecision;
  /** 本轮允许的工具集合（Tool Registry 2.0 授权；空 = 不注入工具）。 */
  tools: string[];
  visionPreprocessing: boolean;
  /** deterministic 生成器（artifact 任务）。 */
  artifactGenerator?: string;
  timeoutMs: number;
  retry: { maxAttempts: number; repairMode: "repair_instruction" | "budget_upgrade" | "validator_feedback" };
  policySource: string;
};

export type ExecutionPolicyInput = {
  requirements: TaskRequirements;
  availableRuntimes?: RuntimeId[];
  availableModels?: string[];
  /** provider 健康（决定 fallback 与模型选择）。 */
  providerHealth?: { model: string; status: string }[];
};

/** 运行时偏好（按任务类型；deterministic-first）。FORCE_AGENTSCOPE=1 时工作区任务优先 AgentScope（benchmark/验收用）。 */
function runtimeFor(requirements: TaskRequirements, availableRuntimes: RuntimeId[]): RuntimeSelection {
  const has = (id: RuntimeId) => availableRuntimes.includes(id);
  const prefer = (primary: RuntimeId, fallbacks: RuntimeId[], reason: string): RuntimeSelection => ({
    runtime: has(primary) ? primary : fallbacks.find((f) => has(f)) || primary,
    reason,
    fallbackRuntimes: fallbacks,
  });

  // 简单产物（无工作区需求）→ deterministic；ZIP/图片/多文件 → Agent runtime
  if (!requirements.workspaceNeeded) {
    return prefer("deterministic", [], "no-workspace: deterministic generator");
  }
  if (process.env.FORCE_AGENTSCOPE === "1") {
    return prefer("agentscope", ["claude-code"], "forced-agentscope (benchmark/acceptance)");
  }
  if (requirements.artifactKinds.some((k) => k === "zip")) {
    return prefer("claude-code", ["agentscope"], "zip-project: agent runtime required");
  }
  if (requirements.visionNeeded) {
    // 图片+HTML：Claude Code 现网最稳；AgentScope 可用时同样满足（WP9 benchmark 后调整）
    return prefer("claude-code", ["agentscope"], "vision-file: agent runtime required");
  }
  return prefer("claude-code", ["agentscope"], "workspace-task: agent runtime required");
}

/** 工具集合按任务授权（WP11：与 Tool Registry 2.0 工具名一致；不是把所有工具都给 Agent）。 */
function toolsFor(requirements: TaskRequirements): string[] {
  if (!requirements.workspaceNeeded) return [];
  const tools = ["filesystem.read", "filesystem.write", "filesystem.list", "artifact.register"];
  if (requirements.artifactKinds.some((k) => k === "zip")) tools.push("archive.extract", "archive.pack");
  if (requirements.visionNeeded) tools.push("vision.read_context");
  // V1.4 WP19：研究/网页类任务（requiredCapabilities 含 browser）授权浏览器工具集
  if (requirements.requiredCapabilities.includes("browser")) {
    tools.push("browser.navigate", "browser.read_page", "browser.click", "browser.type", "browser.scroll", "browser.screenshot", "browser.download", "browser.back");
  }
  return tools;
}

/**
 * 生成执行策略。规则全部 deterministic；
 * model 字段留空由调用方按 modelRole 经 ModelPolicyEngine 再选（策略合流）。
 */
export function planExecutionPolicy(input: ExecutionPolicyInput): ExecutionPolicy {
  const req = input.requirements;
  const runtimes: RuntimeId[] = input.availableRuntimes?.length ? input.availableRuntimes : ["deterministic", "claude-code", "agentscope"];
  const runtime = runtimeFor(req, runtimes);

  // executor 判定（与 Task Router 对齐；退化成 chat 被禁止）
  const executor: ExecutionPolicy["executor"] = req.workspaceNeeded ? "workspace" : req.artifactKinds.length ? "artifact" : "chat";

  // 模型角色 + 推理模式
  let modelRole: ExecutionPolicy["modelRole"] = "chat";
  let reasoningMode: ExecutionPolicy["reasoningMode"] = "auto";
  let maxAttempts = 2;
  let repairMode: ExecutionPolicy["retry"]["repairMode"] = "repair_instruction";

  if (executor === "workspace") {
    modelRole = "agent";
    reasoningMode = "auto";
    maxAttempts = req.visionNeeded || req.artifactKinds.some((k) => k === "zip") ? 3 : 2;
  } else if (executor === "artifact") {
    modelRole = "content";
    reasoningMode = "auto";
    // 产物任务 retry：budget 升级 + validator feedback
    repairMode = "budget_upgrade";
  } else if (req.reasoningNeeded === "high") {
    modelRole = "reasoning";
    reasoningMode = "high";
    repairMode = "budget_upgrade";
  } else if (req.visionNeeded && !req.workspaceNeeded) {
    modelRole = "chat";
    reasoningMode = "auto";
  }

  const budget = budgetFor({
    model: input.availableModels?.[0] || "deepseek-v4-flash",
    taskType: req.taskType,
    reasoningMode,
    artifactKind: req.artifactKinds[0],
    inToolLoop: executor === "workspace",
  });

  const artifactGenerator = executor === "artifact"
    ? (["pptx", "xlsx", "csv", "html", "markdown", "docx"].includes(req.artifactKinds[0]) ? req.artifactKinds[0] : undefined)
    : undefined;

  // V1.3 WP10：模型角色分离（planner/executor/vision；简单任务可相等）。
  // 从 availableModels 经 ModelPolicyEngine 选（capability-safe）。
  const { selectModel } = require("./modelPolicy") as typeof import("./modelPolicy");
  const plannerPick = selectModel({ role: "planner", availableModels: input.availableModels });
  const executorPick = selectModel({ role: "agent", availableModels: input.availableModels });
  const visionPick = selectModel({ role: "vision", availableModels: input.availableModels });

  return {
    taskType: req.taskType,
    executor,
    modelRole,
    reasoningMode,
    budget,
    tools: toolsFor(req),
    visionPreprocessing: req.visionNeeded,
    artifactGenerator,
    timeoutMs: executor === "workspace" ? 15 * 60 * 1000 : executor === "artifact" ? 10 * 60 * 1000 : 5 * 60 * 1000,
    retry: { maxAttempts, repairMode },
    runtime,
    plannerModel: plannerPick.model || undefined,
    executorModel: executor === "workspace" ? (executorPick.model || plannerPick.model || undefined) : undefined,
    visionModel: req.visionNeeded ? (visionPick.model || undefined) : undefined,
    policySource: "ExecutionPolicyEngine:rules",
  };
}
