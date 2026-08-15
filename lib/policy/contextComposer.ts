/**
 * ContextComposer（V1.2 WP27）：Prompt/Agent 上下文分层构建。
 * 优先级（高 → 低）：SystemPolicy（安全/系统规则）> TaskInstruction（任务要求）>
 * Skill（技能约束）> ProjectContext（项目上下文）> UserPreference（用户偏好）。
 * 用户 memory/偏好永远不能覆盖 SystemPolicy（安全规则）。
 */

export type ContextLayer = "system_policy" | "task_instruction" | "skill" | "project" | "user_preference";

export type ComposerInput = {
  systemPolicy?: string;
  taskInstruction: string;
  skills?: string;
  projectContext?: string;
  userPreference?: string;
  /** 附加上下文（如视觉摘要；位置在任务要求之后、用户偏好之前）。 */
  extra?: string;
};

export const LAYER_ORDER: ContextLayer[] = ["system_policy", "task_instruction", "extra", "skill", "project", "user_preference"];

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

/**
 * 构建完整上下文（分层拼接，优先级明确）。
 * system_policy 恒在首位且不可被覆盖；user_preference 恒在末尾。
 */
export function composeContext(input: ComposerInput): string {
  const parts: string[] = [];
  if (input.systemPolicy?.trim()) parts.push(section("系统规则（最高优先级，不可覆盖）", input.systemPolicy.trim()));
  parts.push(section("任务要求", input.taskInstruction.trim()));
  if (input.extra?.trim()) parts.push(section("附加上下文", input.extra.trim()));
  if (input.skills?.trim()) parts.push(section("技能约束（必须遵循）", input.skills.trim()));
  if (input.projectContext?.trim()) parts.push(section("项目上下文", input.projectContext.trim()));
  if (input.userPreference?.trim()) parts.push(section("用户偏好（仅供参考，不得与系统规则冲突）", input.userPreference.trim()));
  return parts.join("\n\n");
}

/** 用户偏好中可能冲突的关键词检测（防覆盖安全规则；调用方据此过滤）。 */
export function preferenceConflictsWithPolicy(userPreference: string, policyKeywords: string[] = ["不得", "禁止", "必须", "不允许"]): string[] {
  const conflicts: string[] = [];
  for (const keyword of policyKeywords) {
    if (userPreference.includes(keyword)) conflicts.push(keyword);
  }
  return conflicts;
}
