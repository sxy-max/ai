/**
 * Worker 执行器（PRD §15-§19、§25）：按步骤类型分发到
 * General（LLM 咨询）/ Research（联网搜索+证据）/ Artifact（文件生成）/ Dev（沙盒代码）。
 */

import { artifactService } from "../artifacts/service";
import type { ArtifactKind } from "../artifacts/types";
import { completeChat } from "../llm/complete";
import { searchWeb, buildEvidenceContext, type WebSource } from "../exa";
import { generateArtifact, isGeneratorKind } from "../generators/registry";
import { llmArtifactContent } from "../generators/llm";
import { specFromLlm, specFromText } from "../generators/presentationSpec";
import { renderPptxFromSpec } from "../generators/pptxRenderer";
import { registerTaskArtifact, listTaskArtifacts } from "./artifacts";
import { emitTaskEvent } from "./repo";
import type { StepContext } from "./context";
import { runDevStep } from "./devExecutor";
import { taskFiles } from "./repo";

export type StepResult = { summary: string };

/** 主分发：执行单个步骤。异常向上抛（Worker 会标记失败）。 */
export async function executeStep(ctx: StepContext): Promise<StepResult> {
  switch (ctx.step.worker_type) {
    case "general": return runGeneral(ctx);
    case "research": return runResearch(ctx);
    case "artifact": return runArtifact(ctx);
    case "dev": return runDev(ctx);
    default: throw new Error(`未知 Worker 类型：${ctx.step.worker_type}`);
  }
}

// ============ General Worker ============

async function runGeneral(ctx: StepContext): Promise<StepResult> {
  await ctx.emit("tool.started", { name: "general", label: "思考与分析" });
  const fileContext = await fileSummaries(ctx);

  const answer = await completeChat({
    messages: [
      {
        role: "system",
        content: `你是云端 AI 工作系统的 General Worker。用中文给出直接、结构化的回答。
${ctx.userMemory ? `用户偏好：${ctx.userMemory}\n` : ""}${ctx.skills ? `技能约束：${ctx.skills}\n` : ""}已知事实必须引用来源；搜索不到的不要编造，明确说“无法确认”。
注意：本系统可生成真实文件（Word/PDF/PPT/Excel/网页等）。若用户要求文件而本步骤确实需要产文件，明确说明需要文件生成步骤；不得回答“作为 AI 我不能生成文件”“请复制到…”。`
      },
      { role: "user", content: `${ctx.step.goal}\n\n${fileContext || "（无输入文件）"}` }
    ],
    maxTokens: 4096,
    timeoutMs: 180_000,
    signal: ctx.signal
  });

  if (answer) {
    await ctx.emit("tool.completed", { name: "general", ok: true, output: answer.slice(0, 500) });
    return { summary: answer.slice(0, 500) };
  }

  // 无模型可用/调用失败：确定性兜底（不假装回答；文案区分"未配置"与"调用失败/超时"）
  const { configuredPlannerProvider } = await import("../llm/complete");
  const provider = configuredPlannerProvider();
  const failureNote = provider
    ? "模型调用失败或超时（模型服务未响应），本步骤未能完成深度分析。"
    : "当前实例未配置回答模型（OPENCODE_GO_API_KEY / DEEPSEEK_API_KEY），本步骤需要模型完成。请配置后重试。";
  const fallback = fileContext
    ? `已读取 ${ctx.files.length} 个文件（${ctx.files.map((f) => f.filename).join("、")}）。${failureNote}`
    : failureNote;
  await ctx.emit("tool.completed", { name: "general", ok: false, output: fallback });
  return { summary: fallback };
}

// ============ Research Worker ============

async function runResearch(ctx: StepContext): Promise<StepResult> {
  await ctx.emit("tool.started", { name: "web_search", label: "联网搜索" });
  const queries = splitQueries(ctx.step.goal);
  const allSources: WebSource[] = [];
  for (const query of queries.slice(0, 3)) {
    try {
      const { sources } = await searchWeb(query, 6, ctx.signal);
      allSources.push(...sources);
    } catch (error) {
      await ctx.emit("tool.completed", { name: "web_search", ok: false, output: error instanceof Error ? error.message : "搜索失败" });
    }
    if (ctx.signal.aborted) throw new Error("TASK_ABORTED");
  }
  if (!allSources.length) throw new Error("联网搜索未返回任何结果（上游 Exa 不可达）");

  // 去重 + 排序
  const unique = dedupeSources(allSources);
  await ctx.emit("tool.completed", { name: "web_search", ok: true, output: `收集到 ${unique.length} 个来源` });

  // 综合报告：优先 LLM，否则聚合证据
  let report = "";
  const llm = await completeChat({
    messages: [
      {
        role: "system",
        content: "你是 Research Worker。基于提供的证据来源撰写中文研究报告（Markdown）。规则：事实标注来源编号 [n]；搜索不到的明确写“无法确认”，禁止编造；结构：概述 → 分点证据 → 结论。"
      },
      { role: "user", content: `研究问题：${ctx.step.goal}\n\n证据来源：\n${buildEvidenceContext(unique)}` }
    ],
    maxTokens: 4096,
    timeoutMs: 240_000,
    signal: ctx.signal
  });
  if (llm) {
    report = llm;
  } else {
    const lines = unique.map((source, index) => {
      const body = (source.content || source.summary || "").slice(0, 600);
      return `### [${index + 1}] ${source.title}\n\nURL：${source.url || "N/A"}\n\n${body}`;
    });
    report = `# 调研报告\n\n> 研究问题：${ctx.step.goal}\n\n${lines.join("\n\n---\n\n")}\n\n（本报告由证据聚合生成，未配置 LLM 综合）`;
  }

  const artifact = await registerTaskArtifact({
    taskId: ctx.task.id,
    userId: ctx.userId,
    projectId: ctx.projectId,
    filename: "调研报告.md",
    name: "调研报告",
    kind: "markdown",
    content: report
  });
  return { summary: `收集 ${unique.length} 个来源并生成调研报告（${artifact.name} v${artifact.version}）` };
}

// ============ Artifact Worker ============

const KIND_HINTS: Array<[ArtifactKind, string[]]> = [
  // V1.4 WP14：目标类型（"转成 Excel"）优先于源类型（"CSV"）——xlsx/excel 在 csv 前
  ["xlsx", ["xlsx", "excel", "电子表格", "数据表"]],
  ["csv", ["csv"]],
  ["pptx", ["pptx", "ppt", "演示", "slides", "幻灯片"]],
  ["docx", ["docx", "word"]],
  ["pdf", ["pdf"]],
  ["html", ["html", "网页", "页面", "网站", "dashboard"]],
  ["markdown", ["markdown", "md", "报告", "文档"]]
];

export function artifactKindFromGoal(goal: string): ArtifactKind {
  const lower = goal.toLowerCase();
  for (const [kind, hints] of KIND_HINTS) {
    if (hints.some((hint) => lower.includes(hint))) return kind;
  }
  // 宽泛兜底：无更具体类型但明确要表格 → xlsx
  if (lower.includes("表格")) return "xlsx";
  return "markdown";
}

async function runArtifact(ctx: StepContext): Promise<StepResult> {
  const kind = artifactKindFromGoal(ctx.step.goal);
  await ctx.emit("tool.started", { name: "generate", label: `生成 ${kind} 文件` });

  if (!isGeneratorKind(kind)) throw new Error(`暂不支持生成 ${kind} 文件`);

  const fileContext = await fileSummaries(ctx);
  const prompt = [
    ctx.step.goal,
    fileContext ? `\n\n参考材料：\n${fileContext}` : "",
    kind === "html" ? "\n\n要求：移动端优先、无横向滚动、可运行。" : ""
  ].join("");

  // F18：LLM 结构化内容优先（PRD §72 需要真实产物内容），失败/未配置回退确定性模板
  let llmContent: string | null = null;
  try {
    llmContent = await llmArtifactContent(kind, ctx.step.goal, fileContext);
  } catch (error) {
    await ctx.emit("tool.completed", { name: "llm_content", ok: false, output: error instanceof Error ? error.message : "LLM 内容生成失败" });
  }
  if (llmContent) {
    await ctx.emit("tool.completed", { name: "llm_content", ok: true, output: `生成 ${llmContent.length} 字符内容` });
  }

  // WP6：PPTX 走结构化 spec 管线（LLM spec → pptxgenjs 渲染；内容与渲染分离）
  if (kind === "pptx") {
    const spec = (await specFromLlm(ctx.step.goal, fileContext)) || specFromText(llmContent || prompt);
    const content = await renderPptxFromSpec(spec);
    const artifact = await registerTaskArtifact({
      taskId: ctx.task.id,
      userId: ctx.userId,
      projectId: ctx.projectId,
      filename: `${spec.title.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "演示文稿"}.pptx`,
      name: spec.title.slice(0, 60),
      kind: "pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      content
    });
    await ctx.emit("tool.completed", { name: "generate", ok: true, output: `演示文稿 ${spec.slides.length} 页 (${content.length} bytes)` });
    return { summary: `生成演示文稿《${spec.title}》（${spec.slides.length} 页，${content.length} bytes）` };
  }

  const output = await generateArtifact(kind, { message: llmContent || prompt });
  const artifact = await registerTaskArtifact({
    taskId: ctx.task.id,
    userId: ctx.userId,
    projectId: ctx.projectId,
    filename: output.filename,
    name: output.filename.replace(/\.[^.]+$/, ""),
    kind: output.kind,
    mime: output.mime,
    content: output.content
  });
  await ctx.emit("tool.completed", { name: "generate", ok: true, output: `${output.filename} (${output.content.length} bytes)` });
  return { summary: `生成 ${output.filename}（${output.content.length} bytes）${llmContent ? "（LLM 内容）" : "（模板内容）"}` };
}

// ============ Dev Worker ============

async function runDev(ctx: StepContext): Promise<StepResult> {
  // Dev Worker = Agent Runtime（V1.2：由 ExecutionPolicy 决定 Claude Code / AgentScope；
  // 默认 Claude Code Runtime（go-ai-file-agent 容器，Claude Code + DeepSeek V4 Flash））
  // 就绪检查在 runDevStep 内（prepare），不可用时抛明确错误
  const files = await taskFiles(ctx.task.id);
  return runDevStep({
    taskId: ctx.task.id,
    stepId: ctx.step.id,
    userId: ctx.userId,
    goal: ctx.step.goal,
    projectId: ctx.projectId,
    files: files.map((f) => ({ id: String(f.id), filename: String(f.filename) })),
    skills: ctx.skills,
    signal: ctx.signal,
    emit: ctx.emit
  }, { policy: ctx.policy });
}

// ============ 工具 ============

async function fileSummaries(ctx: StepContext): Promise<string> {
  if (!ctx.files.length) return "";
  // V1.4 WP46：统一走 InputManifest（文本预览/xlsx sheet 结构/PDF 页数）
  const { buildInputManifest, inputManifestText } = await import("./inputManifest");
  const entries = await buildInputManifest(ctx.files.map((f) => ({ filename: f.filename, size: f.size, storageKey: f.storageKey ?? null })));
  return inputManifestText(entries);
}

function splitQueries(goal: string): string[] {
  const parts = goal.split(/[，,。;；\n]+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return [goal.slice(0, 120)];
  return parts.slice(0, 3).map((part) => part.slice(0, 120));
}

function dedupeSources(sources: WebSource[]): WebSource[] {
  const seen = new Set<string>();
  const result: WebSource[] = [];
  for (const source of sources) {
    const key = source.url || source.title.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result.slice(0, 12);
}

export { listTaskArtifacts };
