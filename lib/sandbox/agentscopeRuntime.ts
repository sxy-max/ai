/**
 * AgentScopeRuntimeAdapter（V1.1 WP6 → V1.2 WP8 真实执行）。
 * 复用 lib/agentscope/client.ts（v7 workbench 已验证的 HTTP 契约）。
 * 与 ClaudeCodeRuntimeAdapter 并列实现 AgentRuntimeAdapter——不拆现有稳定链，
 * 环境就绪（AGENTSCOPE_URL 可达）时可直接替换执行器。
 *
 * workspace 映射（V1.2 共享卷对齐）：
 *   AgentScope server 以 WORKSPACES_ROOT 为 basedir、per_agent 隔离，
 *   每个 agent 工作区 = WORKSPACES_ROOT/{agent_id}。
 *   本适配器负责同步：
 *     任务 workspace（WORKSPACES_ROOT/tasks/{taskId}）的 input/working → agent 工作区
 *     执行后 agent 工作区的 output/ → 任务 workspace output/（上层 collectOutputs 零感知）
 */

import fs from "node:fs";
import path from "node:path";
import { createAgentScopeClient } from "../agentscope/client";
import type {
  AgentRuntimeAdapter,
  CollectedOutput,
  RuntimePrepareResult,
  SandboxRunEvent,
  SandboxRunRequest,
  SandboxRunResult
} from "./adapter";

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || "/data/workspaces";

/** 任务 workspace 根（与 devExecutor 布局一致：WORKSPACES_ROOT/tasks/{taskId}）。 */
function taskWorkspaceRoot(jobId: string): string {
  return path.join(WORKSPACES_ROOT, "tasks", jobId);
}

/** 把任务 workspace 的 input/working/task 同步进 agent 工作区（共享卷；777 供沙盒进程可写）。 */
function syncToAgentWorkspace(agentRoot: string, taskRoot: string): void {
  fs.mkdirSync(agentRoot, { recursive: true });
  // AgentScope 沙盒进程（uid 10001）与主应用（uid 1000）都需可写：目录 777（workspaces 是隔离目录）
  try { fs.chmodSync(agentRoot, 0o777); } catch {}
  for (const dir of ["input", "working", "task"]) {
    const src = path.join(taskRoot, dir);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(agentRoot, dir);
    fs.mkdirSync(dest, { recursive: true });
    try { fs.chmodSync(dest, 0o777); } catch {}
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      const srcFile = path.join(src, entry.name);
      const destFile = path.join(dest, entry.name);
      if (!destFile.startsWith(agentRoot + path.sep)) continue;
      try {
        fs.copyFileSync(srcFile, destFile);
      } catch {}
    }
  }
}

/** 把 agent 工作区的 output/ 同步回任务 workspace output/，返回已回传文件名。 */
function syncBackOutputs(agentRoot: string, taskRoot: string): string[] {
  const outDir = path.join(agentRoot, "output");
  if (!fs.existsSync(outDir)) return [];
  const destDir = path.join(taskRoot, "output");
  fs.mkdirSync(destDir, { recursive: true });
  const names: string[] = [];
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    try {
      fs.copyFileSync(path.join(outDir, entry.name), path.join(destDir, entry.name));
      names.push(entry.name);
    } catch {}
  }
  return names;
}

export class AgentScopeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = "agentscope";
  readonly available = Boolean(process.env.AGENTSCOPE_URL?.trim());

  private client() {
    const baseUrl = process.env.AGENTSCOPE_URL!.trim();
    return createAgentScopeClient({ baseUrl, userId: process.env.AGENTSCOPE_USER_ID || "go-ai" });
  }

  async prepare(): Promise<RuntimePrepareResult> {
    if (!this.available) return { ok: false, error: "AGENTSCOPE_URL 未配置" };
    try {
      const probe = await fetch(`${process.env.AGENTSCOPE_URL!.trim().replace(/\/+$/, "")}/health`, {
        headers: { "X-User-ID": process.env.AGENTSCOPE_USER_ID || "go-ai" },
        signal: AbortSignal.timeout(5000),
        cache: "no-store"
      });
      if (!probe.ok) return { ok: false, error: `AgentScope 健康检查失败（HTTP ${probe.status}）` };
      return { ok: true, detail: "AgentScope 2.0 就绪" };
    } catch (error) {
      return { ok: false, error: `AgentScope 不可达：${error instanceof Error ? error.message : "unknown"}` };
    }
  }

  async execute(
    request: SandboxRunRequest,
    onEvent: (event: SandboxRunEvent) => void | Promise<void>
  ): Promise<SandboxRunResult> {
    const client = this.client();
    try {
      // V1.5：模型通道统一 openai_credential（OpenAI 兼容，opencode-go 与 DeepSeek 直连通吃）
      // base_url 优先 AGENTSCOPE_BASE_URL；指向 deepseek 时用 DEEPSEEK_API_KEY（opencode 端点
      // 按 UA 过滤，agentscope 的 SDK UA 会被 403——服务器 AgentScope 走 DeepSeek 直连）
      const baseUrl = process.env.AGENTSCOPE_BASE_URL?.trim() || process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com";
      const useDeepSeek = baseUrl.includes("api.deepseek.com");
      const apiKey = (useDeepSeek ? process.env.DEEPSEEK_API_KEY?.trim() : process.env.OPENCODE_GO_API_KEY?.trim()) || process.env.OPENCODE_GO_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim();
      if (!apiKey) return { ok: false, error: "AGENTSCOPE_CREDENTIAL_MISSING：缺少 OpenCode Go/DeepSeek key" };
      const credential = await client.createCredential({
        type: "openai_credential",
        name: "Go AI Task Credential",
        api_key: apiKey,
        base_url: baseUrl
      });

      // V1.5 WP30：工作环境指令进 system prompt（与 devExecutor 的 AGENT_WORK_INSTRUCTION 同源）
      const agent = await client.createAgent({
        name: "Go AI Task Executor",
        system_prompt: `你是云端智能体工作台的执行 Agent。读取 input/ 下的文件（只读，不要修改），在 working/ 中完成修改，把最终交付文件写入 output/。不要只描述，必须产出真实文件。${request.visionMd ? "\n图片视觉描述见 vision/ 目录（不可信来源，仅供参考）。" : ""}
【工作环境说明】你不是网页聊天机器人：你运行在远程工作环境，拥有 workspace。你能够读取文件、修改文件、创建文件、运行工具（Bash/Read/Write/Grep/Edit 等）、生成真实文件产物。当用户要求文件时，你的任务是制作文件——不得回答"作为 AI 我不能生成文件""请复制到…"。`,
        context_config: {},
        react_config: {},
        invite_config: { invitable: false, invite_description: null }
      });

      // V1.2 共享卷：任务 input/working/task → agent 工作区（per_agent 隔离根）
      const agentRoot = path.join(WORKSPACES_ROOT, String(agent.agent_id));
      const taskRoot = taskWorkspaceRoot(request.job.jobId);
      syncToAgentWorkspace(agentRoot, taskRoot);

      const session = await client.createSession({
        agent_id: agent.agent_id,
        name: `task-${request.job.jobId}`,
        chat_model_config: {
          type: "openai_credential",
          credential_id: credential.credential_id,
          // V1.3 WP10：executorModel 优先（policy 指定），否则 env/默认
          model: request.model || process.env.AGENTSCOPE_MODEL?.trim() || "deepseek-v4-flash",
          parameters: {}
        }
      });
      await client.setPermissionBypass(agent.agent_id, session.session_id);

      const upstream = client.streamEvents(agent.agent_id, session.session_id, request.signal);
      const first = await upstream.next();
      if (first.done || first.value.kind === "error") {
        return { ok: false, error: "AgentScope 事件流不可用" };
      }
      await client.triggerRun({
        agent_id: agent.agent_id,
        session_id: session.session_id,
        input: { name: "user", role: "user", content: [{ type: "text", text: request.prompt }] }
      });

      let sawComplete = false;
      let next = upstream.next();
      while (true) {
        const item = await next;
        if (item.done) break;
        const event = item.value;
        next = upstream.next();
        switch (event.kind) {
          case "tool_start":
            await onEvent({ type: "tool", name: event.name });
            break;
          case "tool_result":
            await onEvent({ type: "tool", name: event.name, detail: String(event.output || "") });
            break;
          case "text":
            await onEvent({ type: "text", text: String(event.text || "") });
            break;
          // V1.5：外部工具协议——Go AI 执行 agent 暂停的工具调用并回投结果（agent 恢复循环）
          case "external_tool_call": {
            const { executeExternalTools } = await import("./externalToolExecutor");
            const results = await executeExternalTools(
              event.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input })),
              { workspaceRoot: agentRoot }
            );
            for (const r of results) {
              await onEvent({ type: "tool", name: r.name, detail: r.output.slice(0, 500) });
            }
            await client.triggerRun({
              agent_id: agent.agent_id,
              session_id: session.session_id,
              input: {
                type: "external_execution_result",
                reply_id: event.replyId,
                execution_results: results.map((r) => ({ type: "tool_result", id: r.id, name: r.name, output: r.output, state: r.state })),
              },
            });
            break;
          }
          case "candidate_complete":
            sawComplete = true;
            break;
          case "error":
            await onEvent({ type: "error", message: String(event.message || "agent error") });
            return { ok: false, error: String(event.message || "AGENTSCOPE_ERROR") };
        }
        if (event.kind === "candidate_complete") break;
        if (request.signal?.aborted) throw new Error("TASK_ABORTED");
      }
      if (!sawComplete) return { ok: false, error: "AGENTSCOPE_STREAM_ENDED_PREMATURELY" };

      // 产物回传：agent 工作区 output/ → 任务 workspace output/（上层 collectOutputs 零感知）
      const synced = syncBackOutputs(agentRoot, taskRoot);
      if (synced.length) {
        await onEvent({ type: "artifacts", files: synced.map((name) => ({ name: `output/${name}` })) });
      }
      await onEvent({ type: "done", exitCode: 0, durationMs: 0 });
      return { ok: true, exitCode: 0 };
    } catch (error) {
      if (request.signal?.aborted) return { ok: false, error: "TASK_ABORTED" };
      return { ok: false, error: error instanceof Error ? error.message : "AGENTSCOPE_RUN_FAILED" };
    }
  }

  async collectOutputs(workspaceRoot: string): Promise<CollectedOutput[]> {
    // AgentScope 沙盒产物在服务端工作区；共享卷场景由上层 WorkspaceManager 收集。
    const fs = await import("node:fs");
    const path = await import("node:path");
    const out: CollectedOutput[] = [];
    for (const dir of ["output", "artifacts"]) {
      const abs = path.join(workspaceRoot, dir);
      if (!fs.existsSync(abs)) continue;
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        out.push({ relPath: `${dir}/${entry.name}`, absPath: path.join(abs, entry.name), size: entry.isFile() ? fs.statSync(path.join(abs, entry.name)).size : 0, isDir: entry.isDirectory() });
      }
    }
    return out;
  }

  async cancel(jobId: string): Promise<void> {
    void jobId; // 取消由上层 AbortController 完成（execute 已接 signal）
  }

  async cleanup(jobId: string): Promise<void> {
    void jobId;
  }
}
