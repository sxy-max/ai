/**
 * FailureTaxonomy（V1.2 WP22）：统一失败分类。
 * 任务必须知道失败在哪一层；不允许所有错误最终都是 500 Internal Server Error。
 * classify() 把错误信息/代码映射到分类；repairPolicy 据此选择修复动作。
 */

export type FailureCode =
  | "MODEL_UNAVAILABLE"
  | "MODEL_REGION_UNAVAILABLE"
  | "MODEL_REASONING_TRUNCATED"
  | "MODEL_NO_FINAL"
  | "RUNTIME_START_FAILED"
  | "RUNTIME_TIMEOUT"
  | "RUNTIME_EXIT_NONZERO"
  | "TOOL_FAILED"
  | "WORKSPACE_FAILED"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_INVALID"
  | "VISION_FAILED"
  | "VALIDATION_FAILED"
  | "TASK_CANCELLED"
  | "UNKNOWN";

export type FailureClassification = {
  code: FailureCode;
  layer: "model" | "runtime" | "tool" | "workspace" | "artifact" | "validation" | "vision" | "task" | "unknown";
  retryable: boolean;
  detail: string;
};

const RULES: Array<{ pattern: RegExp; code: FailureCode; layer: FailureClassification["layer"]; retryable: boolean }> = [
  { pattern: /MODEL_REGION_UNAVAILABLE|region.*unavailable|地域|地区.*不可用/i, code: "MODEL_REGION_UNAVAILABLE", layer: "model", retryable: false },
  { pattern: /MODEL_UNAVAILABLE|no capable model|model.*not found|HTTP_40[3-4]/i, code: "MODEL_UNAVAILABLE", layer: "model", retryable: false },
  { pattern: /TASK_CANCELLED|TASK_ABORTED|cancelled/i, code: "TASK_CANCELLED", layer: "task", retryable: false },
  { pattern: /sandbox_timeout|RUNTIME_TIMEOUT|TIMEOUT|超时/i, code: "RUNTIME_TIMEOUT", layer: "runtime", retryable: true },
  { pattern: /RUNTIME_START_FAILED|DEV_RUNTIME_UNAVAILABLE|runtime.*不可用|RUNTIME_UNAVAILABLE/i, code: "RUNTIME_START_FAILED", layer: "runtime", retryable: true },
  { pattern: /RUNTIME_EXIT_NONZERO|exit code/i, code: "RUNTIME_EXIT_NONZERO", layer: "runtime", retryable: true },
  { pattern: /TOOL_TIMEOUT|TOOL_FAILED|unknown tool|未知工具/i, code: "TOOL_FAILED", layer: "tool", retryable: true },
  { pattern: /WORKSPACE_FAILED|workspace.*fail|工作区.*失败|path_traversal|file_too_large|too_many_files/i, code: "WORKSPACE_FAILED", layer: "workspace", retryable: false },
  { pattern: /ARTIFACT_INVALID|invalid.*artifact|format.*fail|格式验证失败/i, code: "ARTIFACT_INVALID", layer: "artifact", retryable: true },
  { pattern: /TASK_NO_ARTIFACT|ARTIFACT_MISSING|缺少预期产物|产物总数不足|TASK_CONTRACT_RETRYABLE/i, code: "ARTIFACT_MISSING", layer: "artifact", retryable: true },
  { pattern: /VISION_FAILED|vision.*fail|视觉.*失败|视觉.*失败/i, code: "VISION_FAILED", layer: "vision", retryable: true },
  { pattern: /VALIDATION_FAILED|验证失败|validation.*fail/i, code: "VALIDATION_FAILED", layer: "validation", retryable: true },
  { pattern: /stop.?reason.*length|reasoning truncated|推理达到本轮预算/i, code: "MODEL_REASONING_TRUNCATED", layer: "model", retryable: true },
  { pattern: /MODEL_NO_FINAL|no final|只有推理|没有返回最终/i, code: "MODEL_NO_FINAL", layer: "model", retryable: true },
];

/** 错误 → 统一分类（按规则优先；无命中 → UNKNOWN）。 */
export function classifyFailure(error: string | Error | unknown): FailureClassification {
  const detail = error instanceof Error ? error.message : String(error || "");
  const text = detail;
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return { code: rule.code, layer: rule.layer, retryable: rule.retryable, detail: detail.slice(0, 500) };
    }
  }
  return { code: "UNKNOWN", layer: "unknown", retryable: false, detail: detail.slice(0, 500) };
}

/** 分层标签（UI/日志用）。 */
export function failureLayerLabel(layer: FailureClassification["layer"]): string {
  const labels: Record<FailureClassification["layer"], string> = {
    model: "模型层",
    runtime: "运行时层",
    tool: "工具层",
    workspace: "工作区层",
    artifact: "产物层",
    validation: "验证层",
    vision: "视觉层",
    task: "任务层",
    unknown: "未知层",
  };
  return labels[layer];
}
