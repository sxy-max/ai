/**
 * Job UI 派生逻辑（纯函数，无 DOM，可 node:test 直接测）。
 * 从 JobEvent union 收敛出前端展示用的 JobState，并给出徽标/进度/色调。
 */

import { statusLabel, toolLabel } from "./events";
import type { JobEvent, JobStatus } from "./events";

/** 前端渲染用的 job 状态视图。 */
export type JobState = {
  status: JobStatus;
  /** 当前工具名（原始名，如 Read）。 */
  tool?: string;
  /** 当前工具的中文标签。 */
  toolLabel?: string;
  /** 累积的 agent 文本（progress 事件追加）。 */
  progress?: string;
  /** 最近一次结果摘要。 */
  result?: string;
  /** 错误信息（error 事件设置）。 */
  error?: string;
  /** done 事件的退出码。 */
  exitCode?: number;
};

export const INITIAL_JOB: JobState = { status: "queued" };

/** 展示顺序（用于进度条进度估计）。 */
export const JOB_FLOW: JobStatus[] = [
  "queued",
  "creating_workspace",
  "uploading_files",
  "analyzing_image",
  "reading_files",
  "planning",
  "editing",
  "running_check",
  "generating_artifact",
  "done",
];

export function statusStep(status: JobStatus): number {
  const i = JOB_FLOW.indexOf(status);
  return i === -1 ? 0 : i;
}

/** 状态 → 进度百分比（0–100；done=100，failed 也用满格）。 */
export function jobProgress(status: JobStatus): number {
  if (status === "done" || status === "failed") return 100;
  const i = statusStep(status);
  return Math.round(((i + 1) / JOB_FLOW.length) * 100);
}

export type JobTone = "idle" | "active" | "success" | "error";

export function jobTone(status: JobStatus): JobTone {
  if (status === "done") return "success";
  if (status === "failed") return "error";
  if (status === "queued") return "idle";
  return "active";
}

/** 徽标文案：始终反映阶段状态（工具名由独立 chip 展示）。 */
export function jobBadgeLabel(state: JobState): string {
  if (state.status === "failed") return statusLabel("failed");
  if (state.status === "done") return state.exitCode === 0 ? statusLabel("done") : "未完全完成，已保留结果";
  return statusLabel(state.status);
}

const MAX_PROGRESS = 4000;

/** 事件 → 下一状态（仅收敛展示所需字段；artifact 单独由调用方处理）。 */
export function applyJobEvent(state: JobState, event: JobEvent): JobState {
  switch (event.type) {
    case "status": {
      const next: JobState = { ...state, status: event.status };
      if (event.status !== "failed") next.error = undefined;
      return next;
    }
    case "tool":
      return { ...state, tool: event.name, toolLabel: event.label };
    case "progress": {
      const detail = event.detail || "";
      const prev = state.progress || "";
      return { ...state, progress: prev.length > MAX_PROGRESS ? prev.slice(-MAX_PROGRESS) + detail : prev + detail };
    }
    case "result":
      return { ...state, result: event.summary };
    case "error":
      return { ...state, error: event.message, status: "failed" };
    case "done":
      return { ...state, exitCode: event.exitCode };
    case "artifact":
      return state;
  }
}

/** 文件大小格式化（组件共用）。 */
export function fmtSize(bytes: number): string {
  const b = Number(bytes) || 0;
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

/** 由文件名/mime 推断展示类型（html→内联预览，image→缩略图，其余→下载卡）。 */
export function artifactDisplayKind(name: string, mime: string): "html" | "image" | "file" {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if ((mime || "").startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(lower)) return "image";
  return "file";
}

export { toolLabel, statusLabel };
