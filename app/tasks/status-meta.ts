/** 任务状态展示元数据（客户端共享；与 lib/tasks/state.ts 的 8 态一一对应）。 */
export const STATUS_META: Record<string, { label: string }> = {
  queued: { label: "排队中" },
  planning: { label: "规划中" },
  running: { label: "执行中" },
  waiting_user: { label: "等待用户" },
  paused: { label: "已暂停" },
  completed: { label: "已完成" },
  failed: { label: "失败" },
  cancelled: { label: "已取消" }
};

/** Step 阶段中文标签（WP10：有限 Step 语义）。 */
export const STEP_PHASE_LABELS: Record<string, string> = {
  ANALYZE_INPUT: "分析输入",
  VISION_ANALYSIS: "视觉分析",
  PREPARE_WORKSPACE: "准备工作区",
  RUN_AGENT: "Agent 执行",
  GENERATE_ARTIFACT: "生成产物",
  VALIDATE_ARTIFACT: "验证产物",
  PACKAGE_OUTPUT: "打包输出"
};

export const WORKER_LABELS: Record<string, string> = {
  general: "General Worker",
  research: "Research Worker",
  artifact: "Artifact Worker",
  dev: "Dev Worker"
};

export const STEP_STATUS_LABELS: Record<string, string> = {
  pending: "等待",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
  blocked: "被阻塞"
};

export function readableBytes(value: number | null | undefined) {
  const bytes = value || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function eventLabel(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case "task.created": return `任务已创建：${String(payload.title || "")}`;
    case "task.started": return "任务开始执行";
    case "plan.created": {
      const count = Array.isArray(payload.steps) ? payload.steps.length : 0;
      return `规划完成，共 ${count} 个步骤`;
    }
    case "step.started": return `步骤 ${payload.seq} 开始：${String(payload.title || "")}`;
    case "step.completed": return `步骤 ${payload.seq} 完成：${String(payload.summary || "")}`;
    case "step.failed": return `步骤 ${payload.seq} 失败：${String(payload.error || "")}`;
    case "agent.started": return `${String(payload.worker || "")} 开始工作：${String(payload.title || "")}`;
    case "agent.completed": return `${String(payload.worker || "")} 完成`;
    case "artifact.created": return `生成产物：${String(payload.name || "")} v${String(payload.version || 1)}`;
    case "tool.started": return `使用工具：${String(payload.label || payload.name || "")}`;
    case "tool.completed": return `工具完成：${String(payload.output || (payload.ok ? "成功" : "失败"))}`;
    case "progress": {
      // WP9：Agent 结构化阶段事件（stage → 中文标签 + 详情）
      const stage = String(payload.stage || "");
      const label = AGENT_STAGE_LABELS[stage] || "";
      const detail = String(payload.detail || "");
      return `${label ? `[${label}]` : ""} ${detail}`.trim() || "执行中…";
    }
    case "task.paused": return "任务已暂停";
    case "task.resumed": return "任务已恢复";
    case "task.cancelled": return "任务已取消";
    case "task.retried": return "任务已重试";
    case "task.completed": return "任务完成";
    case "task.failed": return `任务失败：${String(payload.error || "")}`;
    default: return type;
  }
}

/** Agent 阶段 → 中文标签（WP9，与 runAgentJob 的 JobStatus 对齐）。 */
export const AGENT_STAGE_LABELS: Record<string, string> = {
  queued: "任务已排队",
  creating_workspace: "创建工作区",
  uploading_files: "上传文件",
  analyzing_image: "分析图片",
  reading_files: "读取文件",
  planning: "规划方案",
  editing: "修改文件",
  running_check: "执行检查",
  generating_artifact: "生成产物",
  done: "已完成",
  failed: "处理失败",
  // 语义别名（用户要求的 AgentEvent 语义）
  TASK_ACCEPTED: "任务已接受",
  WORKSPACE_CREATING: "创建工作区",
  FILES_STAGING: "文件就位",
  VISION_ANALYZING: "视觉分析中",
  PLANNING: "规划中",
  AGENT_STARTING: "Agent 启动",
  READING_FILE: "读取文件",
  EDITING_FILE: "修改文件",
  RUNNING_COMMAND: "执行命令",
  GENERATING_ARTIFACT: "生成产物",
  VALIDATING: "验证中",
  ARTIFACT_READY: "产物就绪",
  COMPLETED: "已完成",
  FAILED: "失败"
};
