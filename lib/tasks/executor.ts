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
    // 分析/咨询步骤：quick 语义（Claude Code 直接文本回答，无产物契约）——
    // 即使任务级 directive 是 workspace（如"分析输入材料"前置步骤），本步骤也不要求产物
    case "general": {
      const quickDirective = ctx.directive
        ? { ...ctx.directive, profile: "quick" as const, deliveryContract: { validate: "none" as const }, capabilities: ["general" as const] }
        : undefined;
      return runClaudeCodeStep(ctx, quickDirective);
    }
    case "research": return runClaudeCodeStep(ctx);  // 网页研究：search+browser，契约=调研报告
    case "artifact": return runClaudeCodeStep(ctx);  // Office/网页产物：契约=真实格式+页数
    case "dev": return runClaudeCodeStep(ctx);       // 工作区/项目：完整能力面
    default: throw new Error(`未知 Worker 类型：${ctx.step.worker_type}`);
  }
}

/** 统一入口：Preflight directive（由 worker 构建）+ workspace → Claude Code 容器。
 *  本 Goal：directive 按步骤 goal 编译——任务级全文判定会串步骤契约
 *  （"整合 csv + 重构网站 + 打包 zip" 每步应有自己的能力/契约）。 */
async function runClaudeCodeStep(ctx: StepContext, directiveOverride?: import("../preflight/directive").ExecutionDirective): Promise<StepResult> {
  const files = await taskFiles(ctx.task.id);
  const base = directiveOverride ?? ctx.directive;
  let directive = base;
  if (base && ctx.step.goal !== ctx.task.goal) {
    try {
      const { buildDirective } = await import("../preflight/build");
      const { attachmentsFromFiles } = await import("../preflight/attachments");
      directive = await buildDirective({
        goal: ctx.step.goal,
        attachments: attachmentsFromFiles(files.map((f) => ({ filename: String(f.filename), mime: String(f.mime || "") }))),
        projectId: ctx.projectId,
        taskTypeHint: ctx.step.worker_type,
      });
    } catch {
      directive = base; // 步级编译失败回退任务级
    }
  }
  return runDevStep({
    taskId: ctx.task.id,
    stepId: ctx.step.id,
    userId: ctx.userId,
    goal: ctx.step.goal,
    projectId: ctx.projectId,
    files: files.map((f) => ({ id: String(f.id), filename: String(f.filename) })),
    skills: ctx.skills,
    directive,
    signal: ctx.signal,
    emit: ctx.emit
  }, { policy: ctx.policy });
}
