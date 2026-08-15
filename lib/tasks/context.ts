/** 步骤执行上下文（Worker 执行器统一输入）。 */

import type { TaskEventType } from "./types";
import type { ExecutionPolicy } from "../policy/executionPolicy";

export type TaskFileInfo = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  storageKey?: string;
};

export type StepContext = {
  task: {
    id: string;
    title: string;
    goal: string;
    project_id: string | null;
    user_id: string;
  };
  step: {
    id: string;
    seq: number;
    worker_type: "general" | "research" | "artifact" | "dev";
    title: string;
    goal: string;
  };
  userId: string;
  projectId?: string | null;
  files: TaskFileInfo[];
  projectContext?: string;
  userMemory?: string;
  skills?: string;
  /** V1.2：执行策略（由 worker 在规划阶段生成；dev 步骤据此选 runtime/预算）。 */
  policy?: ExecutionPolicy;
  signal: AbortSignal;
  emit: (type: TaskEventType, payload?: Record<string, unknown>) => Promise<void>;
};
