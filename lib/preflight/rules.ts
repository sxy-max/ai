/**
 * Preflight 确定性判定（本 Goal D2）：附件类型 / 明确动作 / 输出格式 / 项目状态 → 能力与契约。
 * 纯规则，无 LLM；只有 buildDirective 在 rules 无法定论时才允许轻量分类模型（见 build.ts）。
 * 规则骨架继承 lib/taskRouter.ts 的 R0-R6（聊天分流），此处扩展为完整能力面。
 */

import type { DirectiveCapability, DeliveryContract, DirectiveProfile, WorkspaceMode } from "./directive";

export type PreflightAttachment = {
  kind: "text" | "image" | "file" | "archive" | "spreadsheet" | "document" | "pdf";
  mime?: string;
  name?: string;
};

export type PreflightInput = {
  goal: string;
  attachments?: PreflightAttachment[];
  projectId?: string | null;
  /** 服务端 classifyTask 的粗分结果（chat / artifact / agent_workspace）。 */
  taskTypeHint?: string;
};

export type RuleVerdict = {
  taskType: string;
  capabilities: DirectiveCapability[];
  deliveryContract: DeliveryContract;
  workspaceMode: WorkspaceMode;
  reasoning: "none" | "auto" | "high";
  profile: DirectiveProfile;
  /** 是否语义模糊（需要轻量分类模型补判路线）。 */
  needsModelClassify: boolean;
  reason: string;
};

const MODIFY_VERBS = /修改|改|调整|重构|重做|修复|改成|按照|根据|照着|模仿|复制|重建|更新|编辑|处理/;
const GENERATE_VERBS = /做|制作|生成|创建|写|给我|出一份|做一份|整理成|转成|转换成|导出|做成|整理|总结|汇总|统计|制作出/;
const PAGE_COUNT = /(\d+)\s*页|(一|两|三|四|五|六|七|八|九|十)\s*页/;
const PAGE_CN: Record<string, number> = { 一: 1, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 目标产物 kind 关键词（确定性）。 */
export function artifactKindFromGoal(goal: string): string | undefined {
  const g = goal.toLowerCase();
  if (/ppt|演示文稿|幻灯片|presentation/i.test(g)) return "pptx";
  if (/(excel|xlsx|表格|电子表格|数据表|spreadsheet)/i.test(g)) return "xlsx";
  if (/\bcsv\b/i.test(g)) return "csv";
  if (/word|docx|文档|文书|报告书/i.test(g)) return "docx";
  if (/\bpdf\b/i.test(g)) return "pdf";
  if (/html|网页|网站|页面|前端/i.test(g)) return "html";
  if (/zip|打包|压缩包|项目包/i.test(g)) return "zip";
  if (/markdown|\.md\b|笔记/i.test(g)) return "markdown";
  return undefined;
}

export function pageConstraintFromGoal(goal: string): { min?: number; max?: number } | undefined {
  const m = goal.match(PAGE_COUNT);
  if (!m) return undefined;
  const n = m[1] ? Number(m[1]) : PAGE_CN[m[2]] ?? undefined;
  if (!n) return undefined;
  return { min: 1, max: n };
}

/**
 * 规则判定（deterministic-first）。规则顺序即优先级：
 * 1) 图片 + 修改动词 → 视觉代码任务（截图改网站）
 * 2) 图片 + 纯问答 → 视觉问答
 * 3) 明确产物 + 生成动词 → artifact（kind/页数契约）
 * 4) 附件处理（spreadsheet/zip/代码）+ 修改动词 → 工作区任务
 * 5) 项目延续（projectId）→ project_agent
 * 6) 明确研究动词 → search
 * 7) 高难推理词 → reasoning
 * 8) 其余 → general
 */
export function applyRules(input: PreflightInput): RuleVerdict {
  const goal = input.goal.trim();
  const hasImage = input.attachments?.some((a) => a.kind === "image") ?? false;
  const hasSpreadsheet = input.attachments?.some((a) => a.kind === "spreadsheet") ?? false;
  const hasArchive = input.attachments?.some((a) => a.kind === "archive") ?? false;
  const hasCodeFile = input.attachments?.some((a) => a.kind === "file" && /\.(ts|js|py|go|rs|c|cpp|java|html|css|json|sh)$/i.test(a.name || "")) ?? false;
  const isModify = MODIFY_VERBS.test(goal);
  const isGenerate = GENERATE_VERBS.test(goal);
  const kind = artifactKindFromGoal(goal);

  // 1. 图片 + 修改（非 Office 产物）→ 截图改网站/图改任务（最高优先：视觉必须进入执行）。
  //    Office 产物（PPT/Excel/Word/PDF）带图片 → 走规则 3：图片是参考素材，产物是文件
  if (hasImage && isModify && kind !== "pptx" && kind !== "xlsx" && kind !== "csv" && kind !== "docx" && kind !== "pdf") {
    const caps: DirectiveCapability[] = ["coding", "vision"];
    return {
      taskType: "vision_file_transform",
      capabilities: caps,
      deliveryContract: { kind: kind || undefined, minCount: 1, validate: "format", mustUseVision: true, mustChangeFiles: true },
      workspaceMode: input.projectId ? "project" : "task",
      reasoning: "auto",
      profile: "workspace",
      needsModelClassify: false,
      reason: "image+modify: vision workspace task",
    };
  }
  // 2. 图片 + 纯问答（无明确产物）→ 视觉问答
  if (hasImage && !kind) {
    return {
      taskType: "chat",
      capabilities: ["general", "vision"],
      deliveryContract: { validate: "none" },
      workspaceMode: "task",
      reasoning: "auto",
      profile: "quick",
      needsModelClassify: false,
      reason: "image+qa: vision chat",
    };
  }
  // 3. 明确产物 + 生成动词 → 产物任务（契约 kind/页数由 Preflight 定，Claude Code 决定怎么做）
  //    有输入材料（附件）→ file_transform 工作区（Claude Code 需读材料）；纯生成 → artifact_generation
  if (kind && isGenerate) {
    const caps: DirectiveCapability[] = ["coding"];
    if (kind === "pptx") caps.push("presentation");
    if (kind === "xlsx" || kind === "csv") caps.push("spreadsheet");
    if (kind === "docx") caps.push("document");
    if (kind === "pdf") caps.push("pdf");
    if (kind === "html") caps.push("browser");
    if (hasSpreadsheet) caps.push("spreadsheet"); // 输入材料需要读
    if (hasImage) caps.push("vision");            // 图片是参考素材（Claude Code 须经 vision-mcp 理解）
    const page = pageConstraintFromGoal(goal);
    const hasInput = (input.attachments?.length ?? 0) > 0;
    return {
      taskType: hasInput ? "file_transform" : "artifact_generation",
      capabilities: caps,
      deliveryContract: {
        kind,
        minCount: 1,
        pageConstraint: page,
        validate: "format",
        filenamePattern: kind ? `*.${kind}` : undefined,
        ...(hasInput ? { mustChangeFiles: true } : {}),
      },
      workspaceMode: "task",
      reasoning: "auto",
      // 产物任务必须真实文件：Claude Code 需要工作区档（quick 仅限文本问答）
      profile: "workspace",
      needsModelClassify: false,
      reason: `${hasInput ? "file_transform" : "artifact"}: ${kind}${page ? ` (${page.max} 页)` : ""}`,
    };
  }
  // 4. 附件处理 + 修改（无明确产物词）→ 工作区任务（Excel 数据整理 / ZIP 项目修改 / 代码修改）
  if ((hasSpreadsheet || hasArchive || hasCodeFile) && isModify) {
    const caps: DirectiveCapability[] = ["coding"];
    if (hasSpreadsheet) caps.push("spreadsheet");
    return {
      taskType: "file_transform",
      capabilities: caps,
      deliveryContract: { kind: hasSpreadsheet ? "xlsx" : undefined, minCount: 1, validate: "format", mustChangeFiles: true },
      workspaceMode: input.projectId ? "project" : "task",
      reasoning: "auto",
      profile: "workspace",
      needsModelClassify: false,
      reason: "files+modify: workspace task",
    };
  }
  // 5. 项目延续（同一 Project 多轮修改）
  if (input.projectId) {
    return {
      taskType: "project_agent",
      capabilities: ["coding", "browser"],
      deliveryContract: { minCount: 1, validate: "format", mustChangeFiles: true },
      workspaceMode: "project",
      reasoning: "auto",
      profile: "workspace",
      needsModelClassify: false,
      reason: "project continuation",
    };
  }
  // 6. 研究/搜索
  if (/研究|搜索|查资料|调研|了解.*情况|找出.*信息|web\s*search|research/i.test(goal)) {
    return {
      taskType: "research",
      capabilities: ["search", "browser", "general"],
      deliveryContract: { kind: "markdown", minCount: 1, validate: "none" },
      workspaceMode: "task",
      reasoning: "auto",
      profile: "workspace",
      needsModelClassify: false,
      reason: "research",
    };
  }
  // 7. 高难推理
  if (/证明|推导|为什么|原理|论证|分析.*原因|数学|算法设计|复杂度|证明.*成立/i.test(goal)) {
    return {
      taskType: "reasoning",
      capabilities: ["reasoning"],
      deliveryContract: { validate: "none" },
      workspaceMode: "task",
      reasoning: "high",
      profile: "quick",
      needsModelClassify: false,
      reason: "deep reasoning",
    };
  }
  // 8. 其余 → general；语义明显无法判定（含多个可能产物）时标记需轻量分类
  const ambiguous = /帮我|建议|怎么|怎么办|如何/.test(goal) && !kind;
  return {
    taskType: "chat",
    capabilities: ["general"],
    deliveryContract: { validate: "none" },
    workspaceMode: "task",
    reasoning: "auto",
    profile: "quick",
    needsModelClassify: ambiguous,
    reason: "fallback chat",
  };
}
