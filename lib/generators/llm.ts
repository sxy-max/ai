/**
 * LLM 内容管线（PRD §21-§23 核心）：任务产物由 LLM 产出结构化内容，再交确定性生成器渲染。
 * LLM 输出与 parseDocument/parseDeck 同构的 Markdown 文本；未配置/失败时调用方回退模板生成。
 */

import { completeChat } from "../llm/complete";
import type { ArtifactKind } from "../artifacts/types";

const KIND_INSTRUCTIONS: Record<string, string> = {
  xlsx: `输出必须包含一个 Markdown 表格（表头 + 数据行），表格内容基于用户材料整理，列名清晰、数据真实来自材料。表格之外不要有额外文字。`,
  csv: `输出必须包含一个 Markdown 表格（表头 + 数据行）。表格之外不要有额外文字。`,
  pptx: `输出为演示文稿提纲，Markdown 格式：第一行 "# 演示标题"，然后每页一个 "## 页标题"，页内容用 "- 要点" 列表（每页 3-5 条）。共 5-8 页。`,
  markdown: `输出为完整文档，Markdown 格式："# 标题"，"## 小节"（3-6 个小节），小节下用 "- 要点" 列表。内容基于用户材料，结构清晰。`,
  html: `输出为网页内容提纲，Markdown 格式："# 页面标题"，"## 版块"（3-6 个版块），版块下用 "- 要点" 列表。`,
  docx: `输出为完整文档，Markdown 格式："# 标题"，"## 小节"，小节下用 "- 要点" 列表。内容完整、可直接作为正式文档。`
};

/** 由 LLM 生成产物内容（Markdown 结构文本）；未配置 LLM 或失败返回 null。 */
export async function llmArtifactContent(
  kind: ArtifactKind,
  goal: string,
  fileContext: string
): Promise<string | null> {
  const instruction = KIND_INSTRUCTIONS[kind] || KIND_INSTRUCTIONS.markdown;
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
  const trimmed = content.trim();
  if (trimmed.length < 20) return null; // 防空壳输出
  return trimmed;
}
