/** Task 状态机：合法迁移校验 + 语义描述（PRD §10）。 */

import type { TaskStatus } from "./types";

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"]);

export type TaskAction = "start" | "plan" | "execute" | "prepare" | "validate" | "pause" | "resume" | "cancel" | "retry" | "continue" | "wait" | "finish" | "fail";

/** 状态机迁移表。from/to 语义；action 用于诊断与校验。 */
const TRANSITIONS: Record<TaskStatus, Partial<Record<TaskStatus, TaskAction>>> = {
  queued: {
    planning: "start",      // Worker 领取
    cancelled: "cancel"     // 排队中取消
  },
  planning: {
    running: "plan",        // Plan 已生成，开始执行
    failed: "fail",
    cancelled: "cancel",
    paused: "pause",
    completed: "finish"
  },
  running: {
    preparing_workspace: "prepare",  // 工作区任务：进入工作区准备
    validating: "validate",          // 产物验证阶段
    retrying: "retry",               // 自动纠错循环
    waiting_user: "wait",            // 需要用户输入
    paused: "pause",
    completed: "finish",
    failed: "fail",
    cancelled: "cancel"
  },
  preparing_workspace: {
    running: "resume",       // 工作区就绪，继续执行
    failed: "fail",
    cancelled: "cancel",
    paused: "pause"
  },
  validating: {
    running: "resume",       // 验证通过，完成
    retrying: "retry",       // 验证失败 → 纠错
    failed: "fail",
    cancelled: "cancel"
  },
  retrying: {
    running: "resume",       // 修复后继续
    failed: "fail",
    cancelled: "cancel"
  },
  waiting_user: {
    running: "resume",      // 用户继续
    cancelled: "cancel"
  },
  paused: {
    running: "resume",      // 用户恢复
    cancelled: "cancel"
  },
  completed: {
    queued: "continue"      // 继续任务：追加新要求后重新入队（复用同一 workspace/产物版本化）
  },
  failed: {
    queued: "retry",        // 重试
    running: "resume"       // 兜底
  },
  cancelled: {
    queued: "retry"         // 重试
  }
};

/** 是否允许迁移。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return to in TRANSITIONS[from];
}

/** 迁移动作名（校验失败时抛错信息用）。 */
export function transitionAction(from: TaskStatus, to: TaskStatus): TaskAction | null {
  return TRANSITIONS[from][to] ?? null;
}

export function assertTransition(from: TaskStatus, to: TaskStatus) {
  if (!canTransition(from, to)) {
    throw new Error(`非法状态迁移：${from} → ${to}`);
  }
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "排队中",
  planning: "规划中",
  running: "执行中",
  preparing_workspace: "准备工作区",
  validating: "验证产物",
  retrying: "自动修复中",
  waiting_user: "等待用户",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

export const STEP_STATUS_LABELS: Record<string, string> = {
  pending: "等待",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
  blocked: "被阻塞"
};

export const WORKER_LABELS: Record<string, string> = {
  general: "General Worker",
  research: "Research Worker",
  artifact: "Artifact Worker",
  dev: "Dev Worker"
};
