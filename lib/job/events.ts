/**
 * Job Event Stream：服务端 job 状态机 + 收敛事件 union + NDJSON 序列化。
 * wire 格式沿用 application/x-ndjson；事件类型收敛为下面 union（不再透传 agent 原始类型）。
 */

import type { ClientArtifact } from "../artifacts/types";

export type JobStatus =
  | "queued"
  | "creating_workspace"
  | "uploading_files"
  | "analyzing_image"
  | "reading_files"
  | "planning"
  | "editing"
  | "running_check"
  | "generating_artifact"
  | "done"
  | "failed";

export type JobEvent =
  | { type: "status"; status: JobStatus; message: string }
  | { type: "tool"; name: string; label: string }
  | { type: "progress"; percent?: number; detail: string }
  | { type: "artifact"; artifact: ClientArtifact }
  | { type: "result"; summary: string }
  | { type: "error"; code: string; message: string }
  | { type: "done"; exitCode: number };

export function serializeJobEvent(event: JobEvent): string {
  return JSON.stringify(event) + "\n";
}

const TOOL_LABELS: Record<string, string> = {
  Read: "读取文件",
  Write: "写入文件",
  Edit: "修改文件",
  MultiEdit: "修改文件",
  Glob: "查找文件",
  Grep: "搜索内容",
  List: "查看目录",
  Look: "查看文件",
  Bash: "执行命令",
  Task: "处理任务",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] || "处理文件";
}

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: "任务已排队",
  creating_workspace: "创建任务说明",
  uploading_files: "上传文件",
  analyzing_image: "分析图片",
  reading_files: "读取文件",
  planning: "规划方案",
  editing: "修改文件",
  running_check: "执行检查",
  generating_artifact: "生成产物",
  done: "已完成",
  failed: "处理失败",
};

export function statusLabel(status: JobStatus): string {
  return STATUS_LABELS[status];
}

/** 工具名 → 生命周期阶段（启发式；驱动 job 状态机）。 */
export function statusForTool(name: string): JobStatus {
  const n = String(name || "");
  if (/(?:^|[^A-Za-z])(?:Read|Glob|Grep|List|Look)(?=$|[^A-Za-z])/i.test(n)) return "reading_files";
  if (/(?:^|[^A-Za-z])(?:Write|Edit|MultiEdit|Insert)(?=$|[^A-Za-z])/i.test(n)) return "editing";
  if (/(?:^|[^A-Za-z])(?:Bash|Exec|Run|Check)(?=$|[^A-Za-z])/i.test(n)) return "running_check";
  if (/pptx|html|csv|markdown|artifact|generate/i.test(n)) return "generating_artifact";
  return "planning";
}
