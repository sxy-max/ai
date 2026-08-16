/**
 * External Tool Executor（V1.5）：AgentScope 外部工具协议执行器。
 * AgentScope agent 暂停产出 REQUIRE_EXTERNAL_EXECUTION 事件（tool_calls），
 * Go AI 侧执行工具并把结果回投 EXTERNAL_EXECUTION_RESULT（agent 恢复循环）。
 * 内置工具语义（Write/Read/Bash/Grep/Glob/Edit）在 Go AI 侧实现，
 * 文件操作落在 agent workspace（与 AgentScope server 共享卷一致）。
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export type ExternalToolCall = {
  id: string;
  name: string;
  /** 原始 JSON 字符串参数。 */
  input: string;
};

export type ExternalToolResult = {
  id: string;
  name: string;
  output: string;
  state: "success" | "error";
};

/** 工具执行上下文（agent workspace 根；服务器 Docker 沙盒经 bind-mount 同步）。 */
export type ExternalToolContext = {
  workspaceRoot: string;
};

function resolvePath(ctx: ExternalToolContext, raw: string): string {
  const p = path.resolve(ctx.workspaceRoot, raw);
  if (!p.startsWith(path.resolve(ctx.workspaceRoot) + path.sep) && p !== path.resolve(ctx.workspaceRoot)) {
    throw new Error(`路径越界：${raw}`);
  }
  return p;
}

function parseArgs(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input || "{}");
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** 执行单个 AgentScope 内置工具（Go AI 侧实现）。 */
export async function executeExternalTool(call: ExternalToolCall, ctx: ExternalToolContext): Promise<ExternalToolResult> {
  const args = parseArgs(call.input);
  try {
    switch (call.name) {
      case "Write": {
        const filePath = resolvePath(ctx, String(args.file_path || args.path || ""));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, String(args.content ?? ""));
        return { id: call.id, name: call.name, output: `Written ${filePath}`, state: "success" };
      }
      case "Read": {
        const filePath = resolvePath(ctx, String(args.file_path || args.path || ""));
        if (!fs.existsSync(filePath)) return { id: call.id, name: call.name, output: `File not found: ${filePath}`, state: "error" };
        const buf = fs.readFileSync(filePath);
        return { id: call.id, name: call.name, output: buf.subarray(0, 200_000).toString("utf8"), state: "success" };
      }
      case "Bash": {
        const command = String(args.command || args.cmd || "");
        if (!command.trim()) return { id: call.id, name: call.name, output: "Empty command", state: "error" };
        const output = await new Promise<string>((resolve, reject) => {
          execFile("bash", ["-lc", command], { cwd: ctx.workspaceRoot, timeout: 60_000, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
            if (err) resolve(`exit ${err.code ?? 1}\n${stdout}\n${stderr}`.trim().slice(0, 10_000));
            else resolve(stdout.slice(0, 10_000));
          });
        });
        return { id: call.id, name: call.name, output, state: "success" };
      }
      case "Grep": {
        const pattern = String(args.pattern || "");
        const filePath = resolvePath(ctx, String(args.path || args.file_path || "."));
        if (!fs.existsSync(filePath)) return { id: call.id, name: call.name, output: "Path not found", state: "error" };
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          const text = fs.readFileSync(filePath, "utf8");
          const lines = text.split("\n").filter((l) => l.includes(pattern)).slice(0, 100);
          return { id: call.id, name: call.name, output: lines.join("\n") || "No matches", state: "success" };
        }
        return { id: call.id, name: call.name, output: "Directory grep not supported in external executor; use Bash grep", state: "error" };
      }
      case "Glob": {
        const dir = resolvePath(ctx, String(args.path || "."));
        if (!fs.existsSync(dir)) return { id: call.id, name: call.name, output: "Path not found", state: "error" };
        const names = fs.readdirSync(dir).slice(0, 200);
        return { id: call.id, name: call.name, output: names.join("\n"), state: "success" };
      }
      case "Edit": {
        const filePath = resolvePath(ctx, String(args.file_path || args.path || ""));
        const oldText = String(args.old_string ?? args.old_text ?? "");
        const newText = String(args.new_string ?? args.new_text ?? "");
        if (!fs.existsSync(filePath)) return { id: call.id, name: call.name, output: `File not found: ${filePath}`, state: "error" };
        const text = fs.readFileSync(filePath, "utf8");
        if (!oldText) return { id: call.id, name: call.name, output: "old_string required", state: "error" };
        if (!text.includes(oldText)) return { id: call.id, name: call.name, output: "old_string not found", state: "error" };
        fs.writeFileSync(filePath, text.replace(oldText, newText));
        return { id: call.id, name: call.name, output: `Edited ${filePath}`, state: "success" };
      }
      default:
        return { id: call.id, name: call.name, output: `Unsupported external tool: ${call.name}`, state: "error" };
    }
  } catch (error) {
    return { id: call.id, name: call.name, output: `Tool failed: ${error instanceof Error ? error.message : String(error)}`, state: "error" };
  }
}

/** 批量执行工具调用。 */
export async function executeExternalTools(calls: ExternalToolCall[], ctx: ExternalToolContext): Promise<ExternalToolResult[]> {
  return Promise.all(calls.map((c) => executeExternalTool(c, ctx)));
}
