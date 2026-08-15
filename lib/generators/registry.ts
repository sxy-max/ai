/** Artifact 生成器注册表：kind → 确定性生成器。 */

import type { ArtifactKind } from "../artifacts/types";
import { generateCsv } from "./csv";
import { generateDocx } from "./docx";
import { generateHtml } from "./html";
import { generateMarkdown } from "./markdown";
import { generatePptx } from "./pptx";
import { generateXlsx } from "./xlsx";
import { PdfGenerator } from "./pdfGenerator";
import { isGeneratorKind, GeneratorError, type ArtifactGenerator, type GeneratorInput, type GeneratorOutput } from "./types";

const REGISTRY: Partial<Record<ArtifactKind, ArtifactGenerator>> = {
  pptx: generatePptx,
  html: generateHtml,
  csv: generateCsv,
  markdown: generateMarkdown,
  xlsx: generateXlsx,
  docx: generateDocx,
  // V1.4 WP12：PDF 生成器（系统 chromium 渲染 HTML→PDF；无浏览器抛错由上层转明确失败）
  pdf: async (input: GeneratorInput): Promise<GeneratorOutput> => {
    const out = await new PdfGenerator().generate({ goal: input.message, fileContext: undefined });
    return { filename: out.filename, mime: out.mime, kind: "pdf", content: out.content };
  },
};

export { isGeneratorKind } from "./types";

/** 按 kind 生成产物；不支持的 kind 抛 GeneratorError("unsupported_kind")。 */
export async function generateArtifact(kind: ArtifactKind, input: GeneratorInput): Promise<GeneratorOutput> {
  if (!isGeneratorKind(kind)) {
    throw new GeneratorError("unsupported_kind", `暂不支持确定性生成 ${kind} 文件`);
  }
  const generator = REGISTRY[kind];
  if (!generator) throw new GeneratorError("unsupported_kind", `缺少 ${kind} 生成器`);
  return generator(input);
}
