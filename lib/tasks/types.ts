/** Task 系统类型定义（PRD §9-§10、§64）。 */

export type TaskStatus =
  | "queued"        // 排队等待 Worker
  | "planning"      // Leader 正在生成 Plan
  | "running"       // 步骤执行中
  | "waiting_user"  // 等待用户输入
  | "paused"        // 用户暂停
  | "completed"
  | "failed"
  | "cancelled";

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "blocked";

export type WorkerType = "general" | "research" | "artifact" | "dev";

export type PlanStep = {
  seq: number;
  worker_type: WorkerType;
  title: string;
  goal: string;
  /** 执行阶段（WP10：有限 Step 语义，UI/恢复用）。 */
  phase?: string;
};

export type TaskRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  parent_task_id: string | null;
  title: string;
  goal: string;
  description: string;
  status: TaskStatus;
  type: "artifact" | "agent_workspace";
  priority: "low" | "normal" | "high";
  current_stage: string;
  progress: number;
  plan: PlanStep[];
  planner_run_id: string | null;
  result_summary: string;
  error: string;
  worker_id: string;
  lease_expires: Date | null;
  created_at: Date;
  started_at: Date | null;
  updated_at: Date;
  completed_at: Date | null;
};

export type TaskStepRow = {
  id: string;
  task_id: string;
  phase?: string;
  seq: number;
  worker_type: WorkerType;
  title: string;
  goal: string;
  status: StepStatus;
  detail: Record<string, unknown>;
  started_at: Date | null;
  completed_at: Date | null;
  error: string;
};

export type AgentRunRow = {
  id: string;
  task_id: string | null;
  step_id: string | null;
  worker_type: WorkerType;
  agent_id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  summary: string;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
};

/** 任务事件（PRD §64 事件名收敛）。 */
export type TaskEventType =
  | "task.created"
  | "task.started"
  | "plan.created"
  | "step.started"
  | "agent.started"
  | "agent.completed"
  | "tool.started"
  | "tool.completed"
  | "artifact.created"
  | "step.completed"
  | "step.failed"
  | "task.waiting"
  | "task.paused"
  | "task.resumed"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.retried"
  | "task.continued"
  | "progress";

export type TaskEventRow = {
  id: string;
  task_id: string;
  type: TaskEventType;
  payload: Record<string, unknown>;
  created_at: Date;
};

export type NewTaskInput = {
  type?: "artifact" | "agent_workspace";
  userId: string;
  title?: string;
  goal: string;
  projectId?: string | null;
  parentTaskId?: string | null;
  priority?: TaskRow["priority"];
  fileIds?: string[];
};
