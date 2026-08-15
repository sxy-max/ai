/**
 * Task Execution Plan（WP2：Agent-First Orchestrator）。
 * 任务创建后由 worker 构建统一执行计划：任务类型 → 执行器 → 模型角色 → 资源需求。
 * 任务型请求（artifact/workspace）禁止退回普通聊天；plan 语义贯穿事件与 UI。
 */

import type { TaskRow } from "./types";
import type { TaskCompletionContract } from "./completion";
import { artifactKindFromGoal } from "./executor";

/** 有限 Step 类型（WP10）：LLM 不得任意创造无法执行的步骤。 */
export type ExecutionStepType =
  | "ANALYZE_INPUT"
  | "VISION_ANALYSIS"
  | "PREPARE_WORKSPACE"
  | "RUN_AGENT"
  | "GENERATE_ARTIFACT"
  | "VALIDATE_ARTIFACT"
  | "PACKAGE_OUTPUT";

export type ExecutionStepTemplate = {
  phase: ExecutionStepType;
  worker: "general" | "research" | "artifact" | "dev";
  description: string;
};

export type ExecutionType =
  | "chat"
  | "artifact_generation"
  | "file_transform"
  | "vision_chat"
  | "vision_file_transform"
  | "workspace_agent"
  | "project_agent";

export type ModelRole = "chat" | "planner" | "content" | "agent" | "vision";

export type TaskExecutionPlan = {
  /** 执行类型（UI/事件/模型选择统一使用）。 */
  taskType: ExecutionType;
  /** 执行器：chat（普通问答）/ artifact（文件生成链）/ workspace（Agent 工作区链）。 */
  executor: "chat" | "artifact" | "workspace";
  /** 主导模型角色。 */
  modelRole: ModelRole;
  needsWorkspace: boolean;
  needsVision: boolean;
  needsFiles: boolean;
  /** 预期产物类型（来自任务意图）。 */
  expectedArtifacts: string[];
  timeout: number;
  capabilities: string[];
  /** 完成契约（WP2）：系统级判定依据，Agent 声称完成不生效。 */
  contract: TaskCompletionContract;
  /** 步骤模板（WP10）：期望执行阶段序列，持久化到 task_steps.phase。 */
  stepsTemplate: ExecutionStepTemplate[];
};

/** 按执行类型产出期望步骤阶段模板（与 planner 产出步骤对齐；LLM 不可任意扩展）。 */
function stepsTemplateFor(executor: string, kind: string | null, hasImages: boolean, hasZip: boolean): ExecutionStepTemplate[] {
  if (executor === "artifact") {
    return [
      { phase: "ANALYZE_INPUT", worker: "general", description: "分析输入材料" },
      { phase: "GENERATE_ARTIFACT", worker: "artifact", description: `生成 ${kind || "文件"}` },
      { phase: "VALIDATE_ARTIFACT", worker: "artifact", description: "验证产物" }
    ];
  }
  const templates: ExecutionStepTemplate[] = [];
  if (hasImages) templates.push({ phase: "VISION_ANALYSIS", worker: "general", description: "视觉分析图片" });
  templates.push({ phase: "PREPARE_WORKSPACE", worker: "general", description: "准备工作区" });
  templates.push({ phase: "RUN_AGENT", worker: "dev", description: hasZip ? "处理项目并重新打包" : "在工作区执行修改" });
  templates.push({ phase: "VALIDATE_ARTIFACT", worker: "dev", description: "验证产物" });
  return templates;
}

const DEFAULT_TIMEOUT = 15 * 60 * 1000;

/** 从任务行与附件信息构建执行计划。 */
export function buildExecutionPlan(task: Pick<TaskRow, "id" | "type" | "goal">, files: Array<{ filename: string }>): TaskExecutionPlan {
  const goal = task.goal.toLowerCase();
  const fileNames = files.map((f) => f.filename.toLowerCase());
  const hasFiles = fileNames.length > 0;
  const hasImages = fileNames.some((n) => /\.(png|jpe?g|gif|webp|svg)$/.test(n));
  const hasZip = fileNames.some((n) => n.endsWith(".zip"));

  if (task.type === "artifact") {
    // 与 executor 实际产出对齐（统一判定，避免 plan 说 csv、执行产出 xlsx 的契约错位）
    const kind = artifactKindFromGoal(task.goal);
    return {
      taskType: "artifact_generation",
      executor: "artifact",
      modelRole: "content",
      needsWorkspace: false,
      needsVision: false,
      needsFiles: hasFiles,
      expectedArtifacts: kind ? [kind] : [],
      timeout: DEFAULT_TIMEOUT,
      capabilities: ["generator", "llm-content"],
      contract: {
        expectations: kind ? [{ kind, minCount: 1, validate: "format" }] : [],
        minArtifacts: 1,
        validationPolicy: "strict"
      },
      stepsTemplate: stepsTemplateFor("artifact", kind, hasImages, false)
    };
  }

  // agent_workspace 类型：按输入细分
  if (task.type === "agent_workspace") {
    // V1.4 WP19：研究/网页类意图 → 授权浏览器工具（沙盒内 Agent 经 host 桥执行）
    const wantsBrowser = /查|搜|研究|调查|调研|浏览|网页|资料|官网|wiki|文章|新闻|网址|报告/.test(goal);
    const base = {
      executor: "workspace" as const,
      modelRole: "agent" as const,
      needsWorkspace: true,
      needsVision: false,
      needsFiles: true,
      expectedArtifacts: ["file"],
      timeout: DEFAULT_TIMEOUT,
      capabilities: ["agent", "workspace", "claude-code", ...(wantsBrowser ? (["browser"] as const) : [])],
      contract: {
        expectations: [] as Array<{ kind?: string; filenamePattern?: string; minCount?: number; mustBeNonEmpty?: boolean; validate?: "format" | "none" }>,
        minArtifacts: 1,
        validationPolicy: "strict" as const
      },
      stepsTemplate: stepsTemplateFor("workspace", null, hasImages, hasZip)
    };
    if (hasImages) {
      return {
        ...base,
        taskType: "vision_file_transform",
        needsVision: true,
        capabilities: [...base.capabilities, "vision"]
      };
    }
    if (hasZip) {
      return {
        ...base,
        taskType: "project_agent",
        expectedArtifacts: ["zip", "file"],
        capabilities: [...base.capabilities, "zip", "multi-file"],
        // V1.4 WP29：项目任务同样必须有非空交付（修复 expectations 为空导致契约形同虚设）
        contract: { ...base.contract, expectations: [{ kind: undefined, filenamePattern: "*", minCount: 1, validate: "format" }] }
      };
    }
    const type = hasFiles ? "file_transform" : "workspace_agent";
    return {
      ...base,
      taskType: type,
      contract: {
        ...base.contract,
        // 工作区任务必须至少交付一个非空文件（类型不限；ZIP 任务同样适用）
        expectations: [{ kind: undefined, filenamePattern: "*", minCount: 1, validate: "format" }]
      }
    };
  }

  // chat（理论上不进任务系统；防御性兜底）
  return {
    taskType: "chat",
    executor: "chat",
    modelRole: "chat",
    needsWorkspace: false,
    needsVision: hasImages,
    needsFiles: hasFiles,
    expectedArtifacts: [],
    timeout: 5 * 60 * 1000,
    capabilities: ["chat"],
    contract: { expectations: [], minArtifacts: 0, validationPolicy: "strict" },
    stepsTemplate: []
  };
}

