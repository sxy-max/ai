/** Artifact 确定性生成器 —— 类型与注册表元信息（纯类型/常量，可被前端引用，不含服务端依赖）。 */

import type { ArtifactKind } from "../artifacts/types";

/** 支持确定性生成的 kind（ppt/html/csv/markdown）。json/txt/zip 等无确定性生成器。 */
export const GENERATOR_KINDS: ReadonlySet<ArtifactKind> = new Set(["pptx", "html", "csv", "markdown"]);

export function isGeneratorKind(kind: ArtifactKind | undefined): kind is "pptx" | "html" | "csv" | "markdown" {
  return kind !== undefined && GENERATOR_KINDS.has(kind);
}

export type GeneratorInput = {
  message: string;
  jobId?: string;
  messageId?: string;
};

export type GeneratorOutput = {
  filename: string;
  mime: string;
  kind: ArtifactKind;
  content: Buffer;
};

export type ArtifactGenerator = (input: GeneratorInput) => Promise<GeneratorOutput>;

export class GeneratorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GeneratorError";
    this.code = code;
  }
}
