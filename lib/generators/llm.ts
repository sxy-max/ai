/**
 * LLM 内容管线（PRD §21-§23 核心）：任务产物由 LLM 产出结构化内容，再交确定性生成器渲染。
 * LLM 输出与 parseDocument/parseDeck 同构的 Markdown 文本；未配置/失败时调用方回退模板生成。
 */

import { completeChat } from "../llm/complete";
import type { ArtifactKind } from "../artifacts/types";

const KIND_INSTRUCTIONS: Record<string, string> = {
  xlsx: `输出必须包含一个 Markdown 表格（表头 + 数据行），表格内容基于用户材料整理，列名清晰、数据真实来自材料。表格之外不要有额外文字。`,
  csv: `输出必须包含一个 Markdown 表格（表头 + 数据行）。表格之外不要有额外文字。`,
  markdown: `输出为完整文档，Markdown 格式："# 标题"，"## 小节"（3-6 个小节），小节下用 "- 要点" 列表。内容基于用户材料，结构清晰。`,
  html: `输出为网页内容提纲，Markdown 格式："# 页面标题"，"## 版块"（3-6 个版块），版块下用 "- 要点" 列表。`,
  docx: `输出为完整文档，Markdown 格式："# 标题"，"## 小节"，小节下用 "- 要点" 列表。内容完整、可直接作为正式文档。`
};

/** 从 goal 提取页数要求（"两页 PPT" → 2；无 → null）。 */
export function extractPageCount(goal: string): number | null {
  const m = String(goal || "").match(/([一二两三四五六七八九十\d]+)\s*页/);
  if (!m) return null;
  const CN: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return CN[m[1]] ?? Number(m[1]);
}

function pptxInstruction(goal: string): string {
  const count = extractPageCount(goal);
  // V1.4 WP58：页数约束必须遵守用户要求（"两页"→2，不是默认 5-8 页）
  return `输出为演示文稿提纲，Markdown 格式：第一行 "# 演示标题"，然后每页一个 "## 页标题"，页内容用 "- 要点" 列表（每页 3-5 条）。共 ${count ? `${count} 页（必须恰好 ${count} 个 "##" 小节，不得多不得少）` : "5-8 页"}。`;
}

/** 由 LLM 生成产物内容（Markdown 结构文本）；未配置 LLM 或失败返回 null。 */
export async function llmArtifactContent(
  kind: ArtifactKind,
  goal: string,
  fileContext: string
): Promise<string | null> {
  const instruction = kind === "pptx" ? pptxInstruction(goal) : (KIND_INSTRUCTIONS[kind] || KIND_INSTRUCTIONS.markdown);
  const content = await completeChat({
    messages: [
      {
        role: "system",
        content: `你是云端 AI 工作系统的 Artifact Worker。根据用户要求与参考材料撰写内容。规则：只基于材料中的事实，材料没有的不要编造，明确写"（材料未提供）"。输出只含内容本身，不要任何前后缀说明。\n\n${instruction}`
      },
      { role: "user", content: `任务目标：${goal}\n\n${fileContext || "（无参考材料）"}` }
    ],
    maxTokens: 8192,
    temperature: 0.4,
    timeoutMs: 240_000
  });
  if (!content || !content.trim()) return null;
  if (content.trim().length < 20) return null; // 防空壳输出
  // 防御：PPT 内容页数截断到用户要求（LLM 偶发超页）
  if (kind === "pptx") {
    const count = extractPageCount(goal);
    if (count) {
      const trimmed = trimSlidesTo(content, count);
      if (trimmed) return trimmed;
    }
  }
  return content;
}

/** 截断 markdown 提纲到前 N 个 "##" 小节（保留 # 标题行）。 */
export function trimSlidesTo(content: string, count: number): string | null {
  const lines = content.split(/\r?\n/);
  const sections: Array<{ index: number; text: string }> = [];
  let current: string[] = [];
  let title = "";
  for (const line of lines) {
    if (/^#\s/.test(line)) { title = line; continue; }
    if (/^#{2,6}\s/.test(line)) {
      if (current.length) sections.push({ index: sections.length, text: current.join("\n") });
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) sections.push({ index: sections.length, text: current.join("\n") });
  if (sections.length <= count) return null;
  const kept = sections.slice(0, count);
  return [title, ...kept.map((s) => s.text)].join("\n");
}
