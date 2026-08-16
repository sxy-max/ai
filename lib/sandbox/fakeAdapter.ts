/**
 * FakeClaudeCodeAdapter：本地任务级测试用（无 file-agent 容器时）。
 *
 * 模拟 Claude Code 容器的执行契约：
 * - 按 Preflight directive 的交付契约，用真实生成器（pptxgenjs/exceljs/docx/pdf）
 *   在 workspace output/ 产出真实格式文件 → 事件流（tool/text/artifacts/done）
 * - quick 模式（普通问答）：返回文本 result
 * - repair 轮次：记录 feedback，产出带 attempt 标记的文件（验证证据回交）
 *
 * 生产不使用（adapterOverride 恒 null；生产走 GoFileAgentAdapter → 容器）。
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentRuntimeAdapter, CollectedOutput, RuntimePrepareResult, SandboxRunEvent, SandboxRunRequest, SandboxRunResult } from "./adapter";
import type { ArtifactKind } from "../artifacts/types";
import { generateArtifact, isGeneratorKind } from "../generators/registry";

const DEFAULT_WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || "/data/workspaces";

export class FakeClaudeCodeAdapter implements AgentRuntimeAdapter {
  readonly id = "claude-code-file-agent";
  readonly available = true;
  private readonly workspacesRoot: string;

  constructor(workspacesRoot: string = DEFAULT_WORKSPACES_ROOT) {
    this.workspacesRoot = workspacesRoot;
  }

  async prepare(): Promise<RuntimePrepareResult> {
    return { ok: true, detail: "fake adapter ready" };
  }

  async collectOutputs(workspaceRoot: string): Promise<CollectedOutput[]> {
    const out: CollectedOutput[] = [];
    const push = (dir: string) => {
      const abs = path.join(workspaceRoot, dir);
      if (!fs.existsSync(abs)) return;
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        out.push({ relPath: `${dir}/${entry.name}`, absPath: path.join(abs, entry.name), size: entry.isFile() ? fs.statSync(path.join(abs, entry.name)).size : 0, isDir: entry.isDirectory() });
      }
    };
    push("output");
    push("artifacts");
    return out;
  }

  async cancel(): Promise<void> {}

  async cleanup(): Promise<void> {}

  execute(request: SandboxRunRequest, onEvent: (event: SandboxRunEvent) => void | Promise<void>): Promise<SandboxRunResult> {
    return this.run(request, onEvent);
  }

  async run(request: SandboxRunRequest, onEvent: (event: SandboxRunEvent) => void | Promise<void>): Promise<SandboxRunResult> {
    const started = Date.now();
    const wsRoot = path.join(this.workspacesRoot, request.job.conversationId, request.job.jobId);
    const outputDir = path.join(wsRoot, "output");
    fs.mkdirSync(outputDir, { recursive: true });

    await onEvent({ type: "tool", name: "filesystem.write", detail: "fake: writing deliverables" });
    await onEvent({ type: "text", text: `[fake adapter] 收到任务：${request.prompt.slice(0, 80)}` });

    const contract = request.directive?.deliveryContract as Record<string, unknown> | undefined;
    const kind = (typeof contract?.kind === "string" ? contract.kind : undefined) as ArtifactKind | undefined;
    const quickMode = request.directive?.profile === "quick" || (contract && contract.validate === "none" && !kind);

    const files: { name: string }[] = [];
    if (!quickMode && kind && isGeneratorKind(kind)) {
      // 真实生成器产出真实格式文件（验证执行链与格式契约，不测生成器本身）
      const output = await generateArtifact(kind, { message: request.prompt });
      const suffix = request.repair && request.repair.round > 0 ? `-r${request.repair.round}` : "";
      const filename = output.filename.replace(/\.[^.]+$/, "") + suffix + path.extname(output.filename);
      fs.writeFileSync(path.join(outputDir, filename), output.content);
      files.push({ name: `output/${filename}` });
      await onEvent({ type: "artifacts", files });
      await onEvent({ type: "result", result: `已生成 ${filename}（${output.content.length} bytes）` });
    } else {
      const repairNote = request.repair ? `\n[validation feedback 已接收] ${request.repair.failures.map((f) => f.code).join("、")}` : "";
      await onEvent({ type: "result", result: `模拟回答：${request.prompt.slice(0, 200)}${repairNote}` });
    }

    await onEvent({ type: "done", exitCode: 0, durationMs: Date.now() - started });
    return { ok: true, exitCode: 0, durationMs: Date.now() - started };
  }
}
