/**
 * Generator Engine（V1.4 WP3）：Artifact Generator 架构。
 * 严格分离：Content Intelligence（LLM 产结构化 spec/内容）≠ File Rendering（物理文件）。
 * 接口：plan → generate → validate → renderPreview → repair。
 * 实现：Presentation / Spreadsheet / Document / PDF / Web / Image。
 */

import type { ArtifactFamily } from "../artifacts/registry";

export type GeneratorPlan = {
  family: ArtifactFamily;
  filename: string;
  spec?: unknown;
  /** 需要的外部输入（文件/上下文摘要）。 */
  requires: string[];
  validationChecks: string[];
};

export type GenerateInput = {
  goal: string;
  fileContext?: string;
  /** 输入文件摘要（ingestion 输出）。 */
  inputDescriptors?: unknown[];
  /** 用户提供的 spec（可选——LLM 产出的结构化内容）。 */
  spec?: unknown;
};

export type GenerateOutput = {
  filename: string;
  content: Buffer;
  mime: string;
  metadata: Record<string, unknown>;
};

export type ValidationIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
  /** 修复建议（repair 用）。 */
  repairHint?: string;
};

export type ValidationReport = {
  ok: boolean;
  issues: ValidationIssue[];
  checks: Record<string, boolean>;
};

export interface ArtifactGenerator {
  readonly family: ArtifactFamily;
  /** 生成计划（LLM 规划后确定性执行）。 */
  plan(goal: string, fileContext?: string): Promise<GeneratorPlan>;
  /** 物理文件生成（内容已由 spec/LLM 就绪）。 */
  generate(input: GenerateInput): Promise<GenerateOutput>;
  /** 格式验证（结构性，非 LLM 打分）。 */
  validate(content: Buffer): Promise<ValidationReport>;
  /** 预览资产（thumbnails/pages/table 等）。 */
  renderPreview(content: Buffer): Promise<Array<{ type: string; data: Buffer; mime: string }>>;
  /** 基于验证结果修复（有限轮）。 */
  repair(input: GenerateInput, issues: ValidationIssue[]): Promise<GenerateOutput>;
}

/* ---------- 注册表 ---------- */

import { PresentationGenerator } from "./presentationGenerator";
import { SpreadsheetGenerator } from "./spreadsheetGenerator";
import { DocumentGenerator } from "./documentGenerator";
import { WebGenerator } from "./webGenerator";
import { PdfGenerator } from "./pdfGenerator";

class UnsupportedGenerator implements ArtifactGenerator {
  readonly family: ArtifactFamily;
  constructor(family: ArtifactFamily) { this.family = family; }
  async plan(): Promise<GeneratorPlan> { throw new Error(`GENERATOR_UNSUPPORTED: ${this.family}`); }
  async generate(): Promise<GenerateOutput> { throw new Error(`GENERATOR_UNSUPPORTED: ${this.family}`); }
  async validate(): Promise<ValidationReport> { return { ok: false, issues: [], checks: {} }; }
  async renderPreview(): Promise<Array<{ type: string; data: Buffer; mime: string }>> { return []; }
  async repair(): Promise<GenerateOutput> { throw new Error(`GENERATOR_UNSUPPORTED: ${this.family}`); }
}

const GENERATORS: Record<ArtifactFamily, ArtifactGenerator> = {
  presentation: new PresentationGenerator(),
  spreadsheet: new SpreadsheetGenerator(),
  document: new DocumentGenerator(),
  webpage: new WebGenerator(),
  pdf: new PdfGenerator(),
  // 本轮未实现的 family：明确报错（不静默）
  image: new UnsupportedGenerator("image"),
  archive: new UnsupportedGenerator("archive"),
  code_project: new UnsupportedGenerator("code_project"),
  text: new UnsupportedGenerator("text"),
  data: new UnsupportedGenerator("data"),
};

export function generatorFor(family: ArtifactFamily): ArtifactGenerator {
  return GENERATORS[family];
}

export function isGeneratorSupported(family: ArtifactFamily): boolean {
  return !(GENERATORS[family] instanceof UnsupportedGenerator);
}

/* ---------- 通用工具 ---------- */

/** 从 ValidationReport 生成 repair 提示（供 LLM/生成器修复）。 */
export function issuesToRepairHint(issues: ValidationIssue[]): string {
  return issues
    .filter((i) => i.severity === "error")
    .map((i) => `- [${i.code}] ${i.message}${i.repairHint ? `（建议：${i.repairHint}）` : ""}`)
    .join("\n");
}
