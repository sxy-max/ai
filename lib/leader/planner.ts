/**
 * 任务规划器（本 Goal 架构：Preflight 是任务编译器，Claude Code 决定 HOW）。
 *
 * 所有智能任务 = 单一 agent 步骤（dev worker），由 Claude Code 在隔离工作区统一执行；
 * 任务差异（主模型 / MCP / 工具 / 交付契约）全部来自 Preflight Execution Directive，
 * 不来自步骤拆分。不再有 general/research/artifact/dev 多型智能步骤——多步拆分让每次
 * 独立容器执行各自编译契约，与整体用户意图错位（旧架构失败来源，本 Goal 已收敛）。
 *
 * 历史：V1.4 及以前这里存在 LLM 规划器（planWithLlm，DeepSeek 拆步骤）。该职责属于
 * Claude Code（HOW），且 Preflight 已能确定性编译全部任务——LLM 规划已删除。
 */

import type { PlanStep, TaskRow } from "../tasks/types";
import { artifactKindFromGoal } from "../preflight/rules";

export type PlanContext = {
  files?: Array<{ filename: string }>;
  projectContext?: string;
  userMemory?: string;
};

/** 产物 kind → 步骤标题（UI 显示；执行仍由单一 dev 步骤完成）。 */
const KIND_LABELS: Record<string, string> = {
  pptx: "演示文稿",
  xlsx: "Excel 表格",
  csv: "CSV 文件",
  pdf: "PDF 文档",
  docx: "Word 文档",
  html: "网页",
  zip: "项目包",
  markdown: "Markdown 文档",
};

/** 生成 Plan：恒为单一 dev 步骤（确定性；无 LLM 规划）。 */
export async function generatePlan(task: TaskRow, context: PlanContext): Promise<PlanStep[]> {
  return planFromRules(task, context);
}

/** 确定性规则规划：单一 agent 步骤（执行差异由 Preflight directive 承载）。 */
export function planFromRules(task: TaskRow, _context: PlanContext): PlanStep[] {
  const kind = task.type === "artifact" ? artifactKindFromGoal(task.goal) : undefined;
  const label = kind ? KIND_LABELS[kind] : undefined;
  return [{
    seq: 1,
    worker_type: "dev",
    phase: "RUN_AGENT",
    title: label ? `生成${label}` : "在工作区执行任务",
    goal: task.goal,
  }];
}
