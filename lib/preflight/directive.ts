/**
 * Execution Directive（本 Goal D3）：Preflight → Claude Code 的精简合同。
 *
 * 只表达 WHAT + CONSTRAINT + CAPABILITY，不表达 HOW：
 * - WHAT：用户原始要求 + 任务意图 + 最终期待结果
 * - CONSTRAINT：交付契约（真实格式/页数/数量/文件变化/视觉使用）、资源限制、验收条件
 * - CAPABILITY：主模型 + fallback + MCP + Tools + Workspace + Skills + Memory
 *
 * HOW（具体步骤）是 Claude Code 的工作。本模块禁止出现任何步骤级描述。
 */

export type DirectiveCapability =
  | "general"       // 普通问答
  | "reasoning"     // 高难推理
  | "coding"        // 代码/项目/多文件
  | "vision"        // 必须理解图片内容（经 vision-mcp）
  | "browser"       // 网页导航/渲染/截图（DOM 优先）
  | "presentation"  // PPT
  | "spreadsheet"   // Excel/CSV
  | "document"      // Word
  | "pdf"           // PDF
  | "search";       // 网页研究（Exa）

/** Claude Code 容器内挂载的 MCP 服务器（工具箱）。 */
export type DirectiveMCP = "vision" | "browser" | "office" | "search";

/** 交付契约（Go AI Validation 依据；Claude Code 声称完成不生效）。 */
export type DeliveryContract = {
  /** 期望产物 kind（pptx/xlsx/docx/pdf/html/zip/markdown/...；留空 = 不限定）。 */
  kind?: string;
  /** 最少产物数量。 */
  minCount?: number;
  /** PPT 页数约束（如"两页 PPT" → max=2）。 */
  pageConstraint?: { min?: number; max?: number };
  /** 文件名模式（如 *.xlsx）。 */
  filenamePattern?: string;
  /** 格式级校验（ArtifactValidator）。 */
  validate: "format" | "none";
  /** 视觉任务：必须使用参考图（Claude Code 未读视觉信息 = 未完成）。 */
  mustUseVision?: boolean;
  /** 修改类任务：必须产生真实文件变化。 */
  mustChangeFiles?: boolean;
};

export type WorkspaceMode = "task" | "project";

export type DirectiveProfile = "quick" | "workspace" | "heavy";

export type ExecutionDirective = {
  /** 任务类型标签（chat / artifact_generation / file_transform / vision_file_transform / workspace_agent / project_agent）。 */
  taskType: string;
  /** 用户原始要求（原样，不重写）。 */
  goal: string;
  /** 本次任务需要的能力（Preflight 判定）。 */
  capabilities: DirectiveCapability[];
  /** 主模型（Auto 解析结果；用户不可见 Auto 内部）。 */
  mainModel: string;
  /** 与 mainModel 对应的 Claude Runtime Profile；每个 job 独立注入。 */
  runtimeProfileId?: "deepseek-flash" | "gpt-luna";
  /** fallback 模型链（同工作环境切换，不重开空任务）。 */
  fallbackModels: string[];
  /** 需要挂载的 MCP 服务器。 */
  mcpServers: DirectiveMCP[];
  /** 授权工具（容器侧参考白名单；空 = Claude Code 原生工具即可）。 */
  tools: string[];
  /** 工作区模式：一次性任务用 task，长期项目用 project。 */
  workspaceMode: WorkspaceMode;
  projectId?: string | null;
  /** 交付契约。 */
  deliveryContract: DeliveryContract;
  /** 推理强度。 */
  reasoning: "none" | "auto" | "high";
  /** 执行档位（决定超时/重试/资源）。 */
  profile: DirectiveProfile;
  /** 相关 Skills（Preflight 只选择，内容交给 Claude Code 上下文）。 */
  skills?: string[];
  /** 相关 Memory（Preflight 只选择，内容交给 Claude Code 上下文）。 */
  memory?: string[];
  /** 用户可见解释/文档的写作与阅读结构约束；代码、日志等原生内容留空。 */
  contentStandard?: string;
  timeoutMs: number;
  maxAttempts: number;
  policySource: string;
};

export const PROFILE_DEFAULTS: Record<DirectiveProfile, { timeoutMs: number; maxAttempts: number }> = {
  quick: { timeoutMs: 3 * 60 * 1000, maxAttempts: 1 },
  workspace: { timeoutMs: 15 * 60 * 1000, maxAttempts: 2 },
  heavy: { timeoutMs: 30 * 60 * 1000, maxAttempts: 3 },
};

/** MCP → 能力映射（preflight 根据能力决定挂载）。 */
export const MCP_FOR_CAPABILITY: Record<DirectiveCapability, DirectiveMCP[]> = {
  general: [],
  reasoning: [],
  coding: [],
  vision: ["vision"],
  browser: ["browser"],
  presentation: ["office"],
  spreadsheet: ["office"],
  document: ["office"],
  pdf: ["office"],
  search: ["search"],
};
