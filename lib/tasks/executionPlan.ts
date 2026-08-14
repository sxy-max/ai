/**
 * Task Execution Plan（WP2：Agent-First Orchestrator）。
 * 任务创建后由 worker 构建统一执行计划：任务类型 → 执行器 → 模型角色 → 资源需求。
 * 任务型请求（artifact/workspace）禁止退回普通聊天；plan 语义贯穿事件与 UI。
 */

import type { TaskRow } from "./types";

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
};

const DEFAULT_TIMEOUT = 15 * 60 * 1000;

/** 从任务行与附件信息构建执行计划。 */
export function buildExecutionPlan(task: Pick<TaskRow, "id" | "type" | "goal">, files: Array<{ filename: string }>): TaskExecutionPlan {
  const goal = task.goal.toLowerCase();
  const fileNames = files.map((f) => f.filename.toLowerCase());
  const hasFiles = fileNames.length > 0;
  const hasImages = fileNames.some((n) => /\.(png|jpe?g|gif|webp|svg)$/.test(n));
  const hasZip = fileNames.some((n) => n.endsWith(".zip"));

  if (task.type === "artifact") {
    const kind = detectArtifactKind(goal);
    return {
      taskType: "artifact_generation",
      executor: "artifact",
      modelRole: "content",
      needsWorkspace: false,
      needsVision: false,
      needsFiles: hasFiles,
      expectedArtifacts: kind ? [kind] : [],
      timeout: DEFAULT_TIMEOUT,
      capabilities: ["generator", "llm-content"]
    };
  }

  // agent_workspace 类型：按输入细分
  if (task.type === "agent_workspace") {
    const base = {
      executor: "workspace" as const,
      modelRole: "agent" as const,
      needsWorkspace: true,
      needsVision: false,
      needsFiles: true,
      expectedArtifacts: ["file"],
      timeout: DEFAULT_TIMEOUT,
      capabilities: ["agent", "workspace", "claude-code"]
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
        capabilities: [...base.capabilities, "zip", "multi-file"]
      };
    }
    return {
      ...base,
      taskType: hasFiles ? "file_transform" : "workspace_agent"
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
    capabilities: ["chat"]
  };
}

function detectArtifactKind(goal: string): string | null {
  const t = goal.toLowerCase();
  if (/ppt|幻灯片/.test(t)) return "pptx";
  if (/html|网页|index/.test(t)) return "html";
  if (/csv|表格/.test(t)) return "csv";
  if (/markdown|\bmd\b/.test(t)) return "markdown";
  if (/\bjson\b/.test(t)) return "json";
  if (/txt|text/.test(t)) return "txt";
  if (/docx|word/.test(t)) return "docx";
  if (/xlsx|excel/.test(t)) return "xlsx";
  return null;
}
