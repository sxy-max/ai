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
    } else if (!quickMode && kind === "zip") {
      // zip 交付：把 output/ 现有文件打包为真实 zip（Claude Code 打包语义）
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const existing = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
      for (const f of existing) {
        if (f.endsWith(".zip")) continue;
        zip.file(f, fs.readFileSync(path.join(outputDir, f)));
      }
      zip.file("交付说明.md", `# 任务交付\n\n原始要求：${request.prompt.slice(0, 300)}\n`);
      const buf = await zip.generateAsync({ type: "nodebuffer" });
      const filename = `项目包${request.repair && request.repair.round > 0 ? `-r${request.repair.round}` : ""}.zip`;
      fs.writeFileSync(path.join(outputDir, filename), buf);
      files.push({ name: `output/${filename}` });
      await onEvent({ type: "artifacts", files });
      await onEvent({ type: "result", result: `已打包 ${filename}（${buf.length} bytes）` });
    } else if (!quickMode) {
      // workspace 任务无明确 kind（如"修改 ZIP 项目"）：Claude Code 至少交付一个文件
      const filename = `交付说明${request.repair && request.repair.round > 0 ? `-r${request.repair.round}` : ""}.md`;
      const content = `# 任务交付说明\n\n原始要求：${request.prompt.slice(0, 300)}\n\n（fake adapter 模拟 Claude Code 在容器内完成工作并交付文件）`;
      fs.writeFileSync(path.join(outputDir, filename), content);
      files.push({ name: `output/${filename}` });
      await onEvent({ type: "artifacts", files });
      await onEvent({ type: "result", result: `已交付 ${filename}` });
    } else {
      const repairNote = request.repair ? `\n[validation feedback 已接收] ${request.repair.failures.map((f) => f.code).join("、")}` : "";
      await onEvent({ type: "result", result: `模拟回答：${request.prompt.slice(0, 200)}${repairNote}` });
    }

    await onEvent({ type: "done", exitCode: 0, durationMs: Date.now() - started });
    return { ok: true, exitCode: 0, durationMs: Date.now() - started };
  }
}
