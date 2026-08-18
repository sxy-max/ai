/**
 * Capability Model（V1.2 WP2）：统一能力声明。
 * 禁止业务层继续散落 model-name 判断：
 *   - ModelCapabilities：模型能力（已知注册表 + 未知模型基础兜底）
 *   - RuntimeCapabilities：运行时能力
 *   - TaskRequirements：任务需求（由分类/plan 产生）
 * 模型选择/运行时选择/预算选择都基于能力，而不是 if model === ...。
 */

/* ---------- 能力 ID（建议全集） ---------- */

export const CAPABILITY_IDS = [
  "text_generation",
  "reasoning",
  "vision",
  "visual_understanding",
  "file_read",
  "file_write",
  "code_execution",
  "shell",
  "browser",
  "structured_output",
  "long_context",
  "artifact_generation",
  "multi_step_agent",
  "workspace",
  "tool_execution",
  "presentation_generation",
  "spreadsheet_processing",
  "deterministic_output",
  "project_edit",
  "state",
  "event_stream",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export type ReasoningLevel = "none" | "low" | "medium" | "high";

export type ModelCapabilities = {
  /** 能力集合。 */
  capabilities: Set<CapabilityId>;
  /** 推理强度（高难推理路由依据）。 */
  reasoning: ReasoningLevel;
  /** 模型标识（未知模型用 "unknown"）。 */
  id: string;
  /** V1.3 WP24：模型要求的出口区域（如 "eligible-egress"）；ProviderRoute 据此路由，非代码 if model。 */
  region?: string;
};

export type RuntimeId = "deterministic" | "claude-code";

export type RuntimeCapabilities = {
  id: RuntimeId;
  capabilities: Set<CapabilityId>;
};

/* ---------- 任务需求 ---------- */

export type TaskRequirements = {
  /** 任务必须满足的能力（模型侧）。 */
  requiredCapabilities: CapabilityId[];
  /** 是否需要推理（影响模型选择与预算）。 */
  reasoningNeeded: "none" | "auto" | "high";
  /** 是否需要视觉。 */
  visionNeeded: boolean;
  /** 是否需要工作区（Agent Runtime 执行）。 */
  workspaceNeeded: boolean;
  /** 是否需要工具循环。 */
  toolsNeeded: boolean;
  /** 预期产物类型（影响 deterministic vs agent 边界与预算档）。 */
  artifactKinds: string[];
  /** 任务类型标签（chat / artifact_generation / file_transform / vision_file_transform / workspace_agent / project_agent）。 */
  taskType: string;
};

/* ---------- 模型能力注册表 ---------- */

/** 已知模型注册（能力配置集中于此；业务层只查能力）。 */
const KNOWN_MODELS: Record<string, ModelCapabilities> = {
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    reasoning: "high",
    capabilities: new Set(["text_generation", "reasoning", "file_read", "long_context", "artifact_generation", "tool_execution", "structured_output"]),
  },
  "deepseek-v4-flash": {
    id: "deepseek-v4-flash",
    reasoning: "medium",
    capabilities: new Set(["text_generation", "reasoning", "file_read", "file_write", "tool_execution", "artifact_generation", "structured_output", "multi_step_agent"]),
  },
  "minimax-m3": {
    id: "minimax-m3",
    reasoning: "medium",
    capabilities: new Set(["text_generation", "vision", "visual_understanding", "long_context", "artifact_generation", "tool_execution"]),
  },
  "qwen3.8-max": {
    id: "qwen3.8-max",
    reasoning: "high",
    capabilities: new Set(["text_generation", "reasoning", "long_context", "artifact_generation", "structured_output"]),
  },
  "glm-5.2": {
    id: "glm-5.2",
    reasoning: "high",
    capabilities: new Set(["text_generation", "reasoning", "long_context", "structured_output"]),
  },
  // 2026-08-17：kimi-k3 已移出模型池（用户成本决策）；能力数据保留在协议层，
  // 经 AGENT_MODEL/FEATURED_MODELS 重新启用时仍有 capability-safe 校验。
  // General/reasoning Claude Runtime Profile；真实可用性来自 runtime probe。
  "gpt-5.6-luna": {
    id: "gpt-5.6-luna",
    reasoning: "high",
    region: "eligible-egress",
    capabilities: new Set(["text_generation", "reasoning", "vision", "visual_understanding", "code_execution", "file_read", "file_write", "tool_execution", "multi_step_agent", "artifact_generation", "structured_output"]),
  },
};

/** 未知模型基础能力（不假设任何高级能力）。 */
function baseUnknownModel(id: string): ModelCapabilities {
  return { id, reasoning: "low", capabilities: new Set(["text_generation"]) };
}

/** 查询模型能力；未知模型返回基础能力。 */
export function capabilitiesForModel(modelId: string): ModelCapabilities {
  return KNOWN_MODELS[modelId] || baseUnknownModel(modelId);
}

export function modelHasCapability(modelId: string, capability: CapabilityId): boolean {
  return capabilitiesForModel(modelId).capabilities.has(capability);
}

/* ---------- Runtime 能力注册表 ---------- */

const KNOWN_RUNTIMES: Record<RuntimeId, RuntimeCapabilities> = {
  deterministic: {
    id: "deterministic",
    capabilities: new Set(["presentation_generation", "spreadsheet_processing", "deterministic_output", "artifact_generation"]),
  },
  "claude-code": {
    id: "claude-code",
    capabilities: new Set(["code_execution", "shell", "multi_step_agent", "workspace", "tool_execution", "file_read", "file_write", "project_edit"]),
  },
};

export function runtimeCapabilities(runtimeId: RuntimeId): RuntimeCapabilities {
  return KNOWN_RUNTIMES[runtimeId] || { id: runtimeId, capabilities: new Set() };
}

export function runtimeHasCapability(runtimeId: RuntimeId, capability: CapabilityId): boolean {
  return runtimeCapabilities(runtimeId).capabilities.has(capability);
}

/* ---------- 任务需求构造（从 TaskExecutionPlan / TaskIntent 归一） ---------- */

export function requirementsFromPlan(plan: {
  taskType: string;
  needsVision: boolean;
  needsWorkspace: boolean;
  expectedArtifacts: string[];
  capabilities: string[];
}): TaskRequirements {
  return {
    requiredCapabilities: (plan.capabilities || []).filter((c) => CAPABILITY_IDS.includes(c as CapabilityId)) as CapabilityId[],
    reasoningNeeded: plan.taskType === "workspace_agent" || plan.taskType === "file_transform" ? "auto" : "auto",
    visionNeeded: plan.needsVision,
    workspaceNeeded: plan.needsWorkspace,
    toolsNeeded: plan.needsWorkspace,
    artifactKinds: plan.expectedArtifacts || [],
    taskType: plan.taskType,
  };
}
