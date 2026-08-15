/**
 * Browser Tools（V1.4 WP19/21）：Agent 网页能力工具集。
 * 会话按 workspace 隔离（同一任务共享导航状态）；崩溃自动重启（WP53）。
 * 下载仅进 workspace/browser-downloads；协议白名单在 runtime 内校验。
 */

import path from "node:path";
import { BrowserRuntime, type BrowserActionInput } from "../browser/runtime";
import type { AgentTool, ToolExecutionContext, ToolResult } from "../tools/registry";

/** 按 workspace 根目录隔离的会话池（任务结束由 executor 显式关闭）。 */
const runtimes = new Map<string, BrowserRuntime>();

export function browserRuntimeFor(workspaceRoot: string): BrowserRuntime {
  let rt = runtimes.get(workspaceRoot);
  if (!rt) {
    rt = new BrowserRuntime({ downloadsDir: path.join(workspaceRoot, "browser-downloads"), headless: true });
    runtimes.set(workspaceRoot, rt);
  }
  return rt;
}

/** 任务结束后关闭（executor 调用；幂等）。 */
export function closeBrowserSession(workspaceRoot: string): Promise<void> {
  const rt = runtimes.get(workspaceRoot);
  if (!rt) return Promise.resolve();
  runtimes.delete(workspaceRoot);
  return rt.shutdown();
}

export function closeAllBrowserSessions(): Promise<void> {
  const all = [...runtimes.values()];
  runtimes.clear();
  return Promise.all(all.map((r) => r.shutdown().catch(() => {}))).then(() => {});
}

function requireWorkspaceRoot(ctx: ToolExecutionContext): string {
  if (!ctx.workspace) throw new Error("TOOL_NEEDS_WORKSPACE：browser 工具需要 workspace（下载/截图写入其中）");
  return ctx.workspace.root;
}

/** 崩溃检测：playwright 进程死亡类错误。 */
function isCrash(message: string): boolean {
  return /crash|closed|disconnected|Target (crashed|closed)|browser has been closed|Session closed/i.test(message);
}

async function actWithSession(input: BrowserActionInput, ctx: ToolExecutionContext): Promise<ToolResult> {
  const root = requireWorkspaceRoot(ctx);
  // 先做协议校验再启动浏览器（无效 URL 不浪费 chromium 启动）
  if (input.action === "navigate" || input.action === "download") {
    const { validateBrowserUrl } = await import("../browser/security");
    const url = input.action === "navigate" ? String((input as { url: string }).url || "") : String((input as { url?: string }).url || "");
    if (input.action === "navigate" || url) {
      const blocked = validateBrowserUrl(url);
      if (blocked) return { ok: false, output: null, error: `BLOCKED_URL：${blocked}` };
    }
  }
  const runtime = browserRuntimeFor(root);
  try {
    const session = await runtime.getSession();
    const obs = await session.act(input);
    return { ok: true, output: JSON.stringify(obs).slice(0, 800) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 浏览器崩溃：关掉会话，下次调用自动重启（WP53 crash recovery）
    if (isCrash(message)) {
      await runtime.shutdown().catch(() => {});
      return { ok: false, output: null, error: `BROWSER_CRASH：${message}（已重置浏览器，请重试当前操作）` };
    }
    return { ok: false, output: null, error: message };
  }
}

type ToolDef = Omit<AgentTool, "execute"> & { action: BrowserActionInput["action"]; toInput: (raw: Record<string, unknown>) => Record<string, unknown> };

const DEFS: ToolDef[] = [
  {
    name: "browser.navigate",
    action: "navigate",
    description: "打开网页（仅 http/https）。返回页面观察：URL/标题/可见文本/可交互元素。",
    inputSchema: { url: "string", waitFor: '"load" | "networkidle"（可选）' },
    permission: "workspace",
    capabilities: ["browser"],
    toInput: (raw) => ({ url: String(raw.url || ""), waitFor: raw.waitFor === "networkidle" ? "networkidle" : "load" }),
  },
  {
    name: "browser.read_page",
    action: "read_page",
    description: "读取当前页面观察（URL/标题/可见文本/链接/按钮/输入框）。withScreenshot=true 时附带截图。",
    inputSchema: { withScreenshot: "boolean（可选）" },
    permission: "workspace",
    capabilities: ["browser"],
    toInput: (raw) => ({ withScreenshot: Boolean(raw.withScreenshot) }),
  },
  {
    name: "browser.click",
    action: "click",
    description: "点击页面元素（CSS selector，如 a[href='/about']、button、.nav a）。",
    inputSchema: { selector: "string" },
    permission: "workspace",
    capabilities: ["browser"],
    toInput: (raw) => ({ selector: String(raw.selector) }),
  },
  {
    name: "browser.type",
    action: "type",
    description: "在输入框输入文字（先点击聚焦）。pressEnter=true 提交。",
    inputSchema: { selector: "string", text: "string", pressEnter: "boolean（可选）" },
    permission: "workspace",
    capabilities: ["browser"],
    toInput: (raw) => ({ selector: String(raw.selector), text: String(raw.text), pressEnter: Boolean(raw.pressEnter) }),
  },
  {
    name: "browser.scroll",
    action: "scroll",
    description: "滚动页面（down/up，默认 600px）。",
    inputSchema: { direction: '"down" | "up"（可选）', amount: "number（可选）" },
    permission: "workspace",
    capabilities: ["browser"],
    toInput: (raw) => ({ direction: raw.direction === "up" ? "up" : "down", amount: typeof raw.amount === "number" ? raw.amount : undefined }),
  },
  {
    name: "browser.screenshot",
    action: "screenshot",
    description: "截取当前页面（PNG data URL），用于视觉验证。",
    inputSchema: {},
    permission: "workspace",
    capabilities: ["browser"],
    toInput: () => ({}),
  },
  {
    name: "browser.download",
    action: "download",
    description: "下载当前页面（或指定 URL）内容到 workspace/browser-downloads/（大小上限 20MB）。",
    inputSchema: { url: "string（可选，缺省下载当前页）" },
    permission: "workspace",
    capabilities: ["browser", "file_write"],
    sideEffects: ["filesystem-write", "browser-download"],
    toInput: (raw) => ({ url: raw.url ? String(raw.url) : undefined }),
  },
  {
    name: "browser.back",
    action: "back",
    description: "返回上一页。",
    inputSchema: {},
    permission: "workspace",
    capabilities: ["browser"],
    toInput: () => ({}),
  },
];

export const BROWSER_TOOLS: AgentTool[] = DEFS.map(({ action, toInput, ...def }) => ({
  ...def,
  execute(input, ctx) {
    return actWithSession({ action, ...toInput(input) } as BrowserActionInput, ctx);
  },
}));

/** 按动作名执行（executor 的 browser research 循环用）。 */
export async function browserAct(action: BrowserActionInput, ctx: ToolExecutionContext): Promise<ToolResult> {
  const def = DEFS.find((d) => d.action === action.action);
  if (!def) return { ok: false, output: null, error: `未知 browser 动作：${action.action}` };
  return actWithSession({ ...action }, ctx);
}
