/**
 * Preflight 组合器（本 Goal D2/D3）：把用户输入编译成 Execution Directive。
 *
 * 流程：applyRules（确定性）→ 语义模糊时才轻量模型分类（只判路线）→
 * resolveMainModel（Auto）→ MCP/工具授权 → Skills/Memory 相关性选择 → 组装 directive。
 * Preflight 不规划任何 HOW。
 */

import { MCP_FOR_CAPABILITY, PROFILE_DEFAULTS, type DirectiveCapability, type ExecutionDirective } from "./directive";
import { applyRules, type PreflightAttachment, type PreflightInput } from "./rules";
import { resolveMainModel, type MainModelSelection } from "./models";
import type { ProviderHealthRegistry } from "../policy/providerHealth";

export type BuildDirectiveInput = {
  goal: string;
  attachments?: PreflightAttachment[];
  projectId?: string | null;
  taskTypeHint?: string;
  /** 用户记忆（已解析条目；preflight 只选择相关项）。 */
  userMemory?: Array<{ id: string; title: string; summary?: string; tags?: string[] }>;
  /** 用户技能（SkillResolver 输出）；preflight 只选择相关项。 */
  userSkills?: Array<{ id: string; name: string; description?: string }>;
  health?: ProviderHealthRegistry;
  availableModels?: string[];
  configuredAgentModel?: string;
  /** 轻量分类模型调用（可选注入；默认 undefined = 不调用，保持 deterministic）。 */
  classify?: (goal: string, attachments: PreflightAttachment[]) => Promise<Partial<RuleVerdictPatch> | null>;
};

export type RuleVerdictPatch = {
  capabilities?: DirectiveCapability[];
  taskType?: string;
};

/** 关键词相关性选择（轻量；后续可替换为现有 SkillResolver/Memory 索引）。 */
function selectRelevant<T extends { id: string; name?: string; title?: string; description?: string; summary?: string; tags?: string[] }>(
  items: T[] | undefined,
  goal: string
): string[] {
  if (!items?.length) return [];
  const g = goal.toLowerCase();
  const scored = items
    .map((item) => {
      const haystack = [item.name, item.title, item.description, item.summary, (item.tags || []).join(" ")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack) return { item, score: 0 };
      const terms = g.split(/[\s,，。、/]+/).filter((t) => t.length >= 2);
      const score = terms.filter((t) => haystack.includes(t)).length;
      return { item, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((s) => s.item.id);
}

export async function buildDirective(input: BuildDirectiveInput): Promise<ExecutionDirective> {
  const verdict = applyRules(input);

  // 语义模糊时才允许轻量分类模型（只补判路线；不执行任务）
  let capabilities = verdict.capabilities;
  let taskType = verdict.taskType;
  if (verdict.needsModelClassify && input.classify) {
    try {
      const patch = await input.classify(input.goal, input.attachments || []);
      if (patch?.capabilities?.length) {
        capabilities = patch.capabilities;
        taskType = patch.taskType || taskType;
      }
    } catch {
      // 分类失败不阻塞：维持规则判定
    }
  }

  const selection: MainModelSelection | null = await resolveMainModel({
    capabilities,
    reasoning: verdict.reasoning,
    health: input.health,
    availableModels: input.availableModels,
    configuredAgentModel: input.configuredAgentModel,
  });
  if (!selection) {
    throw new Error("PREFLIGHT_NO_MODEL：当前模型池无健康可用模型");
  }

  // MCP 挂载（去重、保序）
  const mcpServers = Array.from(new Set(capabilities.flatMap((c) => MCP_FOR_CAPABILITY[c])));

  // 工具授权（与 lib/tools/registry.ts 工具名一致；容器侧参考）
  const tools: string[] = [];
  if (capabilities.includes("coding") || capabilities.includes("browser")) {
    tools.push("filesystem.read", "filesystem.write", "filesystem.list", "artifact.register");
  }
  if (capabilities.includes("browser")) {
    tools.push("browser.navigate", "browser.read_page", "browser.click", "browser.type", "browser.scroll", "browser.screenshot", "browser.download", "browser.back");
  }
  if (capabilities.includes("spreadsheet")) {
    tools.push("spreadsheet.read_workbook", "spreadsheet.list_sheets", "spreadsheet.read_range", "spreadsheet.write_range", "spreadsheet.add_sheet", "spreadsheet.delete_sheet", "spreadsheet.sort_range", "spreadsheet.filter_rows", "spreadsheet.create_formula", "spreadsheet.create_chart", "spreadsheet.format_cells", "spreadsheet.save_workbook");
  }

  const profileDefaults = PROFILE_DEFAULTS[verdict.profile];
  return {
    taskType,
    goal: input.goal,
    capabilities,
    mainModel: selection.mainModel,
    fallbackModels: selection.fallbackModels,
    mcpServers,
    tools,
    workspaceMode: verdict.workspaceMode,
    projectId: input.projectId ?? null,
    deliveryContract: verdict.deliveryContract,
    reasoning: verdict.reasoning,
    profile: verdict.profile,
    skills: selectRelevant(input.userSkills, input.goal),
    memory: selectRelevant(input.userMemory, input.goal),
    timeoutMs: profileDefaults.timeoutMs,
    maxAttempts: profileDefaults.maxAttempts,
    policySource: `Preflight:${verdict.reason}`,
  };
}
