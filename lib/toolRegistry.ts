/**
 * Tool Registry —— 受控的工具扩展层。
 *
 * 普通聊天模型只获得当前任务相关的工具；用户 Skill 与 MCP 严格区分：
 * - Skill = instruction / workflow knowledge（纯文本，注入 system）
 * - MCP  / Tool = 可执行能力（通过本 Registry 注册与授权）
 *
 * 用户上传的普通 Skill 绝不自动获得 MCP / shell 权限。
 * 内置工具由 trigger() 按当前任务决定是否激活；外部 MCP 由注册方显式注册，
 * 默认 enabled=false（需显式授权后才进入 resolveTaskTools 结果）。
 */

export type ToolCapability = "web_search" | "url_fetch" | "vision" | "file_agent" | "external_mcp";

export type TaskContext = {
  searchMode: "off" | "auto" | "on";
  hasUrls: boolean;
  hasImages: boolean;
  hasFiles: boolean;
};

export type ToolDef = {
  id: string;
  name: string;
  capability: ToolCapability;
  description: string;
  /** 内置工具由任务触发器决定；外部工具默认关闭，显式授权后为 true。 */
  enabled: boolean;
  builtin: boolean;
  /** 当前任务是否激活（内置工具使用）。外部工具忽略。 */
  trigger?: (prompt: string, ctx: TaskContext) => boolean;
};

/* ---------- 任务触发器（从 page.tsx 收敛到此，单一决策源） ---------- */

const FILE_TASK_HINTS = ["修改这个", "编辑", "改一下", "改成", "改背景", "生成一个", "创建", "给我文件", "发文件", "生成 index", "帮我修", "处理这个", "根据截图", "按照截图", "修一下", "这个项目", "处理代码", "改一下这个", "改成浅色", "改成深色", "改颜色"];

export function isFileTaskPrompt(p: string, hasFiles: boolean): boolean {
  const t = String(p || "").toLowerCase();
  if (!t.trim()) return false;
  if (FILE_TASK_HINTS.some((h) => t.includes(h))) return true;
  if (hasFiles && /(修改|编辑|改|处理|修复|根据|按照)/.test(t)) return true;
  return false;
}

/** 联网搜索触发器：时间/时效/价格等信号，避免每个问题都联网。 */
export function searchTriggerHeuristic(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return /(今天|昨天|最新|现在|目前|今年|价格|套餐|发布|更新|新闻|政策|版本|官网|文档|下载|股价|天气|比赛|排行|latest|current|today|price|pricing|release|docs|news|2025|2026)/i.test(t);
}

export const BUILTIN_TOOLS: ToolDef[] = [
  {
    id: "web_search",
    name: "联网搜索",
    capability: "web_search",
    description: "通过 Exa 检索最新资料（仅服务端，结果视为 untrusted）",
    enabled: true,
    builtin: true,
    trigger: (prompt, ctx) => ctx.searchMode === "on" || (ctx.searchMode === "auto" && searchTriggerHeuristic(prompt)),
  },
  {
    id: "url_fetch",
    name: "URL 读取",
    capability: "url_fetch",
    description: "读取用户提供的公开 URL 内容",
    enabled: true,
    builtin: true,
    trigger: (_prompt, ctx) => ctx.hasUrls,
  },
  {
    id: "vision",
    name: "图片理解",
    capability: "vision",
    description: "MiniMax 视觉分析（非 vision 模型自动预处理，结果标记 UNTRUSTED）",
    enabled: true,
    builtin: true,
    trigger: (_prompt, ctx) => ctx.hasImages,
  },
  {
    id: "file_agent",
    name: "文件 Agent",
    capability: "file_agent",
    description: "Claude Code + DeepSeek V4 Flash：读取/编辑/生成真实文件",
    enabled: true,
    builtin: true,
    trigger: (prompt, ctx) => isFileTaskPrompt(prompt, ctx.hasFiles),
  },
];

class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  constructor() {
    for (const tool of BUILTIN_TOOLS) this.tools.set(tool.id, tool);
  }

  register(tool: ToolDef): void {
    this.tools.set(tool.id, { ...tool });
  }

  get(id: string): ToolDef | undefined {
    return this.tools.get(id);
  }

  unregister(id: string): boolean {
    return this.tools.delete(id);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  /** 当前任务相关的工具（内置触发器 + 已授权的外部工具）。 */
  resolveTaskTools(prompt: string, ctx: TaskContext): ToolDef[] {
    return this.list().filter((t) => (t.builtin ? t.trigger?.(prompt, ctx) : t.enabled));
  }
}

/** 进程级单例：外部 MCP 在启动时 register，默认关闭、显式授权后可用。 */
export const toolRegistry = new ToolRegistry();

/** 便捷函数：解析当前任务应激活的工具 id 列表。 */
export function resolveTaskTools(prompt: string, ctx: TaskContext): string[] {
  return toolRegistry.resolveTaskTools(prompt, ctx).map((t) => t.id);
}
