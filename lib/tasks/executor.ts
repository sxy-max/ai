/**
 * Worker 执行器：按步骤类型分发。
 *
 * 本 Goal 架构：Claude Code 是唯一主 Harness——general / research / artifact / dev
 * 四种步骤全部由 runClaudeCodeStep 统一执行（差异来自 Preflight Execution Directive：
 * 主模型 / MCP / 工具 / 交付契约）。完整回答、联网研究、Office 文件、项目修改
 * 都由容器内 Claude Code 自主完成；Generator/Browser/Vision/Search 是它的工具箱。
 */

import { artifactService } from "../artifacts/service";
import type { ArtifactKind } from "../artifacts/types";
import { registerTaskArtifact, listTaskArtifacts } from "./artifacts";
import type { StepContext } from "./context";
import { runDevStep } from "./devExecutor";
import { taskFiles } from "./repo";

export type StepResult = { summary: string };

/** 主分发：所有智能步骤统一经 Claude Code 主 Harness（差异 = directive）。 */
export async function executeStep(ctx: StepContext): Promise<StepResult> {
  switch (ctx.step.worker_type) {
    case "general": return runClaudeCodeStep(ctx);   // 普通问答：轻量 profile（文本答案）
    case "research": return runClaudeCodeStep(ctx);  // 网页研究：search+browser，契约=调研报告
    case "artifact": return runClaudeCodeStep(ctx);  // Office/网页产物：契约=真实格式+页数
    case "dev": return runClaudeCodeStep(ctx);       // 工作区/项目：完整能力面
    default: throw new Error(`未知 Worker 类型：${ctx.step.worker_type}`);
  }
}

/** 统一入口：Preflight directive（由 worker 构建）+ workspace → Claude Code 容器。 */
async function runClaudeCodeStep(ctx: StepContext): Promise<StepResult> {
  const files = await taskFiles(ctx.task.id);
  return runDevStep({
    taskId: ctx.task.id,
    stepId: ctx.step.id,
    userId: ctx.userId,
    goal: ctx.step.goal,
    projectId: ctx.projectId,
    files: files.map((f) => ({ id: String(f.id), filename: String(f.filename) })),
    skills: ctx.skills,
    directive: ctx.directive,
    signal: ctx.signal,
    emit: ctx.emit
  }, { policy: ctx.policy });
}
