/**
 * Lightweight server-side response-quality layer.
 * Routes a chat request to a "skill" that appends a focused system instruction
 * BEFORE the request reaches the model. No LLM calls, no vector DB, no agents.
 * Normal chat returns "" (zero intervention / zero token overhead).
 *
 * 解释/分析/知识类：在现有指令之上叠加 Go AI 统一内容标准
 * （lib/content-standard：structure-standard.md + 关系修辞表达生成器.md 的合成版，
 *   按任务复杂度裁剪；短答只加护栏不膨胀）。标准在模型生成之前进入，不是事后润色。
 */

import { contentStandardText, detectContentComplexity } from "./content-standard";

export type Skill = "" | "academic" | "technical" | "analysis";

const ACADEMIC_HINTS = [
  "是什么", "什么意思", "含义", "为什么", "怎么理解", "原理", "机制", "本质", "解释", "推导", "证明",
  "定理", "公式", "方程", "物理", "数学", "概率", "统计", "概念", "区别",
  "差异", "对比", "关系", "原因", "影响", "分析一下这个",
  "what is", "meaning", "derive", "explain", "why", "equation", "theorem", "principle", "concept",
  "difference between", "mechanism",
];

const TECHNICAL_HINTS = [
  "代码", "报错", "错误", "修复", "编译", "运行", "函数", "接口", "api",
  "docker", "部署", "配置", "性能", "内存", "线程", "数据库", "sql", "bug",
  "error", "fix", "exception", "debug", "build", "npm", "git", "crash",
  "segfault", "超时",
];

const ANALYSIS_HINTS = [
  "总结", "分析", "评估", "优缺点", "报告", "综述", "对比分析", "长文",
  "要点", "关键发现", "summary", "analyze", "evaluate", "compare",
  "pros and cons", "takeaways",
];

function lastUserText(messages: { role: string; content: string }[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return (last?.content || "").slice(0, 3000).toLowerCase();
}

function hits(text: string, hints: string[]): number {
  let n = 0;
  for (const h of hints) if (text.includes(h)) n += 1;
  return n;
}

export function detectSkill(messages: { role: string; content: string }[]): Skill {
  const text = lastUserText(messages);
  if (!text.trim()) return "";
  const academic = hits(text, ACADEMIC_HINTS);
  const technical = hits(text, TECHNICAL_HINTS);
  const analysis = hits(text, ANALYSIS_HINTS);

  // technical wins when there is a concrete code/error/deploy signal
  if (technical >= 1 && /(代码|报错|错误|修复|error|bug|docker|api|函数|编译|部署|exception)/.test(text)) return "technical";
  // broad analysis/长文 signal beats generic academic
  if (analysis >= 1 && /(总结|分析|评估|优缺点|报告|综述|长文|summary|analyze|evaluate)/.test(text) && analysis >= academic) return "analysis";
  if (academic >= 1) return "academic";
  return "";
}

const ACADEMIC_INSTRUCTION = [
  "你在回答一个知识/学术类问题。组织回答时：",
  "- 先识别真正需要回答的中心问题，不要被枝节带偏。",
  "- 对数学/物理/推导类：保留必要推导、不删严谨性，但避免重复的代数搬运；每给出一个关键公式后，用一两句话说明\"这个式子说明了什么\"；关键结果要突出；最后解释其物理或实际意义。",
  "- 数学格式：简短符号可用行内公式；含多个分式/求和/多层上下标/连续等号推导的复杂式子一律用块级公式独占一行；一行不要连续堆大量复杂公式；每个公式之后用一句话说明它在证明什么。",
  "- 对抽象概念：不要术语堆砌。按\"中心判断 → 拆开易混概念 → 底层关系 → 机制 → 用一个能压实差异的具体例子 → 必要边界 → 结束\"组织。",
  "- 通用：Markdown 层级清楚；不要每句话都拆成 bullet；不要为了显得完整随意增加无关扩展；不要写\"以下是详细分析\"之类的无意义开场；不需要输出隐藏的思考过程。",
].join("\n");

const TECHNICAL_INSTRUCTION = [
  "你在回答一个技术/代码类问题。组织回答时：",
  "- 优先给结论，再讲根因，然后是修复/做法，最后给验证方式。",
  "- 不要写大段泛科普，直接针对问题。",
  "- 代码用清晰格式，关键行可加行内注释。",
  "- Markdown 层级清楚；不需要输出隐藏的思考过程。",
].join("\n");

const ANALYSIS_INSTRUCTION = [
  "你在做长文/综合分析。组织回答时：",
  "- 先给关键结论/要点，再展开支撑论据。",
  "- 有对比时给清晰对比结构；有数字时保留关键数字。",
  "- 结尾用一两句话收束，不重复已说内容。",
  "- Markdown 层级清楚；不需要输出隐藏的思考过程。",
].join("\n");

export function skillInstruction(skill: Skill, lastUserText?: string): string {
  if (skill === "academic") {
    const complexity = detectContentComplexity(lastUserText || "");
    return [ACADEMIC_INSTRUCTION, contentStandardText(complexity === "deep" ? "deep" : "normal")].join("\n\n");
  }
  if (skill === "analysis") {
    return [ANALYSIS_INSTRUCTION, contentStandardText("deep")].join("\n\n");
  }
  if (skill === "technical") return TECHNICAL_INSTRUCTION;
  return "";
}
