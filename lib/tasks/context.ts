/** 步骤执行上下文（Worker 执行器统一输入）。 */

import type { TaskEventType } from "./types";

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
  signal: AbortSignal;
  emit: (type: TaskEventType, payload?: Record<string, unknown>) => Promise<void>;
};
