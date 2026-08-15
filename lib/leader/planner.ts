/**
 * Leader Agent 规划器（PRD §13-§14）：把用户目标拆解为 Worker 步骤列表。
 * 优先用 LLM 规划（DeepSeek），不可用时走确定性规则（保证离线闭环）。
 */

import { completeChat, extractJson } from "../llm/complete";
import type { PlanStep, TaskRow, WorkerType } from "../tasks/types";

export const WORKER_TYPES: WorkerType[] = ["general", "research", "artifact", "dev"];

export type PlanContext = {
  files?: Array<{ filename: string }>;
  projectContext?: string;
  userMemory?: string;
};

const PLANNER_SYSTEM_PROMPT = `你是云端 AI 工作系统的任务规划者（Leader Agent）。
用户只描述目标，你负责把它拆解为可执行的步骤序列。
步骤类型（worker_type）只有四种：
- general：咨询、分析、总结、解释、文案等不需要联网和写代码的工作
- research：需要联网搜索、收集证据、调研的工作
- artifact：需要产出文件的工作（文档 markdown/docx、表格 xlsx/csv、演示文稿 pptx、网页 html）
- dev：需要写代码、脚本、运行命令、开发软件的工作
规则：
1. 一个任务 1-8 步；步骤之间有依赖时保持顺序。
2. 需要先了解材料再产出的任务，先加 general/research 步骤，再加 artifact 步骤。
3. 涉及联网调研再总结出报告的：research → artifact(markdown)。
4. 每个步骤的 goal 必须写明该步骤要交付的东西（文件/报告/修改结果），不要只写"思考""回答"。
5. 输出严格为 JSON 数组，不要任何其他文字：
[{"seq":1,"worker_type":"research","title":"步骤标题","goal":"该步骤要完成的具体目标"}]`;

/** 生成 Plan；LLM 失败或未配置时回退到规则规划。 */
export async function generatePlan(task: TaskRow, context: PlanContext): Promise<PlanStep[]> {
  // agent_workspace 类型：强制确定性单 dev 步骤（一次容器执行完成全部工作，
  // 避免 LLM 拆出多个独立 dev 步骤导致每步只做表面操作、无产物交付）
  if (task.type === "agent_workspace") return planFromRules(task, context);
  const llmPlan = await planWithLlm(task, context);
  if (llmPlan?.length) return llmPlan;
  return planFromRules(task, context);
}

async function planWithLlm(task: TaskRow, context: PlanContext): Promise<PlanStep[] | null> {
  const fileLines = context.files?.length
    ? context.files.map((f) => `- ${f.filename}`).join("\n")
    : "（无）";
  const userMessage = [
    `用户目标：${task.goal}`,
    `已上传文件：\n${fileLines}`,
    context.projectContext ? `项目上下文：\n${context.projectContext}` : "",
    context.userMemory ? `用户偏好：\n${context.userMemory}` : ""
  ].filter(Boolean).join("\n\n");

  const raw = await completeChat({
    messages: [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "user", content: userMessage }
    ],
    jsonMode: true,
    maxTokens: 4096,
    temperature: 0.2,
    timeoutMs: 90_000
  });
  if (!raw) return null;

  const parsed = extractJson<unknown>(raw);
  const rows = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.steps) ? parsed.steps : null;
  if (!rows) return null;
  return normalizePlan(rows, task.goal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePlan(rows: unknown[], goal: string): PlanStep[] | null {
  const steps: PlanStep[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const workerType = typeof row.worker_type === "string" && WORKER_TYPES.includes(row.worker_type as WorkerType)
      ? (row.worker_type as WorkerType)
      : "general";
    const title = typeof row.title === "string" && row.title.trim() ? row.title.trim().slice(0, 120) : "处理任务";
    const stepGoal = typeof row.goal === "string" && row.goal.trim() ? row.goal.trim() : goal;
    steps.push({ seq: steps.length + 1, worker_type: workerType, title, goal: stepGoal.slice(0, 2000) });
  }
  if (!steps.length) return null;
  if (steps.length > 12) return steps.slice(0, 12);
  return steps;
}

// ============ 确定性规则规划（无模型 fallback）============

export function planFromRules(task: TaskRow, context: PlanContext): PlanStep[] {
  const goal = task.goal.toLowerCase();

  // agent_workspace 类型：强制走 Workspace 执行链（不按关键词兜底成 artifact/chat）
  // LLM_EXECUTION_CHAIN §2.2C：图片+文件修改 / 多文件联动 / 项目构建必须进工作区
  if (task.type === "agent_workspace") {
    const steps: PlanStep[] = [];
    const fileNames = (context.files || []).map((f) => f.filename.toLowerCase());
    if (fileNames.length) {
      steps.push({ seq: 1, worker_type: "general", phase: "ANALYZE_INPUT", title: "分析输入材料", goal: `阅读并分析用户提供的文件（${fileNames.join("、")}），提取关键信息与要点。` });
    }
    steps.push({
      seq: steps.length + 1,
      worker_type: "dev",
      phase: "RUN_AGENT",
      title: "在工作区执行任务",
      goal: `在隔离工作区中执行：${task.goal}。读取 input/ 下的文件（含图片的视觉描述），按任务要求修改/生成文件，验证后产出到 outputs/。`
    });
    return steps;
  }

  const fileNames = (context.files || []).map((f) => f.filename.toLowerCase());
  const hasFiles = fileNames.length > 0;

  const steps: PlanStep[] = [];
  const want = (keyword: string[]) => keyword.some((k) => goal.includes(k));

  // 1. 需要材料但目标没说清楚 → 先分析输入
  if (hasFiles && (want(["分析", "总结", "看一下", "看看", "整理", "处理"]) || goal.length < 30)) {
    steps.push({ seq: 1, worker_type: "general", title: "分析输入材料", goal: `阅读并分析用户提供的文件（${fileNames.join("、")}），提取关键信息与要点。` });
  }

  // 2. 联网调研
  if (want(["研究", "调研", "搜索", "查一下", "查一查", "市场", "竞品", "比较", "资料收集", "资料整理", "行业"])) {
    steps.push({ seq: steps.length + 1, worker_type: "research", title: "收集资料与证据", goal: `围绕「${task.goal}」进行联网调研，收集可靠来源的证据（新闻、官网、官方文档等），整理成结构化证据。` });
  }

  // 3. 咨询/分析/总结
  if (want(["总结", "分析", "撰写", "写一篇", "解释", "回答", "咨询", "介绍", "说明", "报告内容", "方案", "建议", "建议书"])) {
    steps.push({ seq: steps.length + 1, worker_type: "general", title: "分析并输出结论", goal: task.goal });
  }

  // 4. 文档（报告/总结文档）
  if (want(["文档", "报告", "markdown", "md", "docx", "word", "总结文档", "输出总结", "文字总结"])) {
    steps.push({ seq: steps.length + 1, worker_type: "artifact", title: "生成文档", goal: `根据已有材料生成 markdown 文档：${task.goal}` });
  }

  // 4b. PDF（V1.4：规则规划器缺 PDF 分支曾导致 PDF 任务落 general → LLM 拒绝式回答）
  if (want(["pdf", "做成 pdf", "转成 pdf", "导出 pdf", "排版成 pdf"])) {
    steps.push({ seq: steps.length + 1, worker_type: "artifact", title: "生成 PDF 文件", goal: `把内容排版生成真实 PDF 文件：${task.goal}` });
  }

  // 5. 表格（按目标细分：csv 请求 → csv，其余 → xlsx）
  if (want(["表格", "excel", "xlsx", "csv", "数据表", "电子表格", "整理成表"])) {
    const wantsCsv = /csv/.test(goal);
    steps.push({ seq: steps.length + 1, worker_type: "artifact", title: wantsCsv ? "生成 CSV 文件" : "生成表格文件", goal: `根据已有材料生成 ${wantsCsv ? "csv" : "xlsx"} 表格：${task.goal}` });
  }

  // 6. PPT
  if (want(["ppt", "演示", "slides", "幻灯片", "宣讲", "路演", "deck"])) {
    steps.push({ seq: steps.length + 1, worker_type: "artifact", title: "生成演示文稿", goal: `根据已有材料生成 pptx 演示文稿：${task.goal}` });
  }

  // 7. 网页
  if (want(["网页", "html", "网站", "页面", "dashboard", "仪表盘", "交互页面", "报告页"])) {
    steps.push({ seq: steps.length + 1, worker_type: "artifact", title: "生成网页", goal: `根据已有材料生成移动端优先的 html 网页：${task.goal}` });
  }

  // 8. 代码开发
  if (want(["程序", "脚本", "代码", "开发", "软件", "工具", "爬虫", "自动化", "api", "cli", "应用"])) {
    steps.push({ seq: steps.length + 1, worker_type: "dev", title: "开发与验证", goal: `在沙盒中实现并验证：${task.goal}` });
  }

  // 兜底
  if (!steps.length) {
    steps.push({ seq: 1, worker_type: "general", title: "处理任务", goal: task.goal });
  }

  return steps.map((step, index) => ({ ...step, seq: index + 1 }));
}
