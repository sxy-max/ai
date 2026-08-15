/**
 * RuntimeToolProtocol（V1.3 WP7）：统一工具调用协议。
 * ClaudeCodeRuntime / AgentScopeRuntime / DockerSandbox / LocalSandbox 全部归一。
 * Runtime 只负责"如何执行"；Agent 不知道底下是哪种执行环境。
 */

export type ToolPermission = "workspace:read" | "workspace:write" | "runtime:execute" | "network:restricted" | "artifact:create";

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** 单次执行超时（ms）。 */
  timeoutMs?: number;
  /** 所需权限（策略授权用）。 */
  permissions?: ToolPermission[];
};

export type ToolResult = {
  id: string;
  status: "success" | "error";
  stdout?: string;
  stderr?: string;
  data?: unknown;
  /** 本次调用修改的文件（相对 workspace）。 */
  filesChanged?: string[];
  durationMs?: number;
};

export type ToolError = {
  id: string;
  code: string;
  message: string;
  retryable: boolean;
};

/** 从任意来源构造 ToolError。 */
export function toolError(id: string, code: string, message: string, retryable = false): ToolError {
  return { id, code, message, retryable };
}

/** ToolResult → ToolError（结果状态转换）。 */
export function resultToError(result: ToolResult): ToolError {
  return {
    id: result.id,
    code: "TOOL_RESULT_ERROR",
    message: result.stderr || result.stdout || "tool failed",
    retryable: true,
  };
}

/* ---------- 映射：SandboxExecResult → ToolResult ---------- */

import type { SandboxExecResult } from "./manager";

export function execResultToToolResult(id: string, exec: SandboxExecResult, filesChanged?: string[]): ToolResult {
  return {
    id,
    status: exec.ok ? "success" : "error",
    stdout: exec.stdout,
    stderr: exec.stderr,
    filesChanged,
    durationMs: exec.durationMs,
  };
}

/* ---------- 映射：SandboxRunEvent → ToolCall/ToolResult ---------- */

import type { SandboxRunEvent } from "./adapter";

/** Agent 工具调用归一：工具名 → 协议 ToolCall（事件流中的 tool 事件）。 */
export function sandboxToolEventToCall(event: Extract<SandboxRunEvent, { type: "tool" }>, index: number): ToolCall {
  const detail = typeof event.detail === "string" ? event.detail : "";
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(detail);
    if (parsed && typeof parsed === "object") args = parsed;
  } catch {
    args = { detail };
  }
  return {
    id: `tool-${index}-${Date.now()}`,
    name: event.name,
    arguments: args,
  };
}

/** 归一化工具执行（任何 runtime 的 SandboxRunEvent 都产出 ToolResult）。 */
export function sandboxEventToToolResult(event: SandboxRunEvent): ToolResult | null {
  switch (event.type) {
    case "tool":
      return null; // 调用开始不是结果
    case "result":
      return { id: "result", status: "success", stdout: event.result };
    case "done":
      return {
        id: "done",
        status: event.exitCode === 0 ? "success" : "error",
        stderr: event.exitCode === 0 ? undefined : `exit ${event.exitCode}`,
        durationMs: event.durationMs,
      };
    case "error":
      return { id: "error", status: "error", stderr: event.message };
    default:
      return null;
  }
}

/* ---------- 统一工具执行接口（Agent 视角） ---------- */

/** 执行器实现：runtime 提供，Agent 通过 SandboxToolExecutor 调用。 */
export interface SandboxToolExecutor {
  /** 执行一个工具调用（跨 runtime 归一）。 */
  executeTool(call: ToolCall): Promise<ToolResult>;
}

/** 包装 SandboxManager 为 ToolExecutor（文件/命令工具在沙盒内执行）。 */
export function sandboxManagerExecutor(options: {
  sandboxId: string;
  workspaceRoot: string;
  manager: import("./manager").SandboxManager;
  allowedNames?: string[];
}): SandboxToolExecutor {
  const { sandboxId, workspaceRoot, manager, allowedNames } = options;
  return {
    async executeTool(call) {
      if (allowedNames && !allowedNames.includes(call.name)) {
        return { id: call.id, status: "error", stderr: `工具未授权: ${call.name}` };
      }
      try {
        switch (call.name) {
          case "filesystem.read": {
            const path = String(call.arguments.path ?? call.arguments.file_path ?? "");
            const r = await manager.readFile(sandboxId, workspaceRoot, path);
            return r.ok
              ? { id: call.id, status: "success", data: { content: r.content?.toString("utf8") } }
              : { id: call.id, status: "error", stderr: r.error };
          }
          case "filesystem.write": {
            const path = String(call.arguments.path ?? call.arguments.file_path ?? "");
            const content = String(call.arguments.content ?? "");
            const r = await manager.writeFile(sandboxId, workspaceRoot, path, Buffer.from(content, "utf8"));
            return r.ok
              ? { id: call.id, status: "success", filesChanged: [path] }
              : { id: call.id, status: "error", stderr: r.error };
          }
          case "filesystem.list": {
            const dir = String(call.arguments.dir ?? ".");
            const r = await manager.listFiles(sandboxId, workspaceRoot, dir);
            return r.ok
              ? { id: call.id, status: "success", data: { files: r.files } }
              : { id: call.id, status: "error", stderr: r.error };
          }
          case "code.node.exec": {
            const code = String(call.arguments.code ?? "");
            const exec = await manager.exec(sandboxId, workspaceRoot, ["node", "-e", code], {
              timeoutMs: call.timeoutMs,
            });
            return execResultToToolResult(call.id, exec);
          }
          // V1.4 WP19：浏览器工具桥——沙盒内 Agent 经 host 侧 BrowserRuntime 执行（沙盒 --network none 不拦浏览器）
          case "browser.navigate":
          case "browser.read_page":
          case "browser.click":
          case "browser.type":
          case "browser.scroll":
          case "browser.screenshot":
          case "browser.download":
          case "browser.back": {
            const { browserAct } = await import("../browser/tools");
            const { WorkspaceManager } = await import("../workspace/service");
            const action = call.name.split(".")[1] as "navigate" | "read_page" | "click" | "type" | "scroll" | "screenshot" | "download" | "back";
            const result = await browserAct(
              { action, ...call.arguments } as never,
              { taskId: "sandbox", userId: "system", workspace: new WorkspaceManager(workspaceRoot) }
            );
            if (result.ok) return { id: call.id, status: "success", data: result.output };
            return { id: call.id, status: "error", stderr: result.error || "browser 工具执行失败" };
          }
          case "shell.exec": {
            const command = call.arguments.command;
            const args = Array.isArray(command) ? command.map(String) : [String(command ?? "")];
            const exec = await manager.exec(sandboxId, workspaceRoot, ["sh", "-c", args.join(" ")], {
              timeoutMs: call.timeoutMs,
            });
            return execResultToToolResult(call.id, exec);
          }
          default:
            return { id: call.id, status: "error", stderr: `沙盒未提供工具: ${call.name}` };
        }
      } catch (error) {
        return { id: call.id, status: "error", stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
