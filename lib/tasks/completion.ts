/**
 * Agent Completion Contract（V1.1 WP2）。
 * 任务完成判定由系统决定，禁止以「模型声称完成」为依据：
 *   Agent 执行完成 → collectOutputs → 检查 expectedArtifacts → Artifact 验证 → 满足契约 → completed
 * 否则 retryable_failed（可修复）或 failed。
 */

import type { ArtifactKind } from "../artifacts/types";

/** 预期产物声明（由 TaskExecutionPlan 携带）。 */
export type ArtifactExpectation = {
  /** 产物类型（artifact.kind）。 */
  kind?: ArtifactKind | string;
  /** 文件名模式（glob，如 *.pptx / index.html）。 */
  filenamePattern?: string;
  /** 该类型最少数量。 */
  minCount?: number;
  /** 必须非空（默认 true）。 */
  mustBeNonEmpty?: boolean;
  /** 格式验证策略：strict = 执行 ArtifactValidator（V11-WP12）；none = 仅存在性。 */
  validate?: "format" | "none";
};

/** 任务完成契约。 */
export type TaskCompletionContract = {
  expectations: ArtifactExpectation[];
  /** 任务最少产物总数（含未匹配 expectation 的产物）。 */
  minArtifacts: number;
  /** strict：全部 expectations 满足才 completed；lenient：任一满足即可。 */
  validationPolicy: "strict" | "lenient";
};

export type ArtifactValidationResult = {
  artifactId: string;
  filename: string;
  kind: string;
  ok: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
  error?: string;
};

export type CompletionVerdict =
  | { status: "completed"; results: ArtifactValidationResult[]; summary: string }
  | { status: "retryable_failed"; reason: string; missing: ArtifactExpectation[]; results: ArtifactValidationResult[] }
  | { status: "failed"; reason: string; missing: ArtifactExpectation[]; results: ArtifactValidationResult[] };

export type TaskArtifactLike = {
  id: string;
  name: string;
  type: string;
  size: number;
  status: string;
  downloadUrl?: string;
};

/** 文件名 glob 匹配（支持 * 与 ?）。 */
export function matchesGlob(pattern: string, filename: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(filename);
}

/** 判断产物是否满足某一 expectation。 */
export function artifactMatchesExpectation(artifact: TaskArtifactLike, expectation: ArtifactExpectation): boolean {
  if (expectation.kind && String(artifact.type).toLowerCase() !== String(expectation.kind).toLowerCase()) return false;
  if (expectation.filenamePattern && !matchesGlob(expectation.filenamePattern, artifact.name)) return false;
  if (expectation.mustBeNonEmpty !== false && artifact.size <= 0) return false;
  return true;
}

/**
 * 系统级完成判定（WP2 核心）。
 * 仅做存在性/类型/文件名匹配；格式验证（validate="format"）由 WP12 的 ArtifactValidator 注入。
 */
export async function validateTaskCompletion(
  taskId: string,
  artifacts: TaskArtifactLike[],
  contract: TaskCompletionContract,
  formatValidator?: (artifactId: string, filename: string, kind: string) => Promise<ArtifactValidationResult | null>
): Promise<CompletionVerdict> {
  const results: ArtifactValidationResult[] = [];
  const byExpectation = contract.expectations.map((expectation) => {
    const matched = artifacts.filter((a) => artifactMatchesExpectation(a, expectation));
    const minCount = expectation.minCount ?? 1;
    return { expectation, matched, satisfied: matched.length >= minCount };
  });

  for (const artifact of artifacts) {
    if (formatValidator) {
      const validation = await formatValidator(artifact.id, artifact.name, artifact.type);
      if (validation) results.push(validation);
    }
  }

  const missing = byExpectation.filter((e) => !e.satisfied).map((e) => e.expectation);
  const formatFailures = results.filter((r) => !r.ok);

  const policyOk = contract.validationPolicy === "lenient"
    ? byExpectation.some((e) => e.satisfied)
    : missing.length === 0;
  const minOk = artifacts.length >= contract.minArtifacts;
  const formatOk = formatFailures.length === 0;

  if (policyOk && minOk && formatOk) {
    return {
      status: "completed",
      results,
      summary: `完成契约满足：${artifacts.length} 个产物（${artifacts.map((a) => a.name).join("、")}）`
    };
  }

  const reasons: string[] = [];
  if (missing.length) reasons.push(`缺少预期产物：${missing.map((m) => m.filenamePattern || m.kind || "artifact").join("、")}`);
  if (!minOk) reasons.push(`产物总数不足（${artifacts.length} < ${contract.minArtifacts}）`);
  if (!formatOk) reasons.push(`产物格式验证失败（${formatFailures.length} 项）`);

  // 契约缺口可修复（agent 重跑可能产出）→ retryable；格式失败同样可修复
  return {
    status: "retryable_failed",
    reason: reasons.join("；"),
    missing,
    results
  };
}
