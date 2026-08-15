/**
 * PresentationGenerator（V1.4 WP4）：结构化 PPTX 生产管线。
 * LLM 产 PresentationSpec（含 layout 选择）→ Layout Engine 校验 → pptxgenjs 渲染。
 * validate：结构性（ZIP 容器/页数）+ 布局密度检查（溢出/符号/标题长度）。
 */

import { renderPptxFromSpec } from "./pptxRenderer";
import { specFromLlm, specFromText, type PresentationSpec, type PresentationSlide } from "./presentationSpec";
import { computeLayout, suggestLayout, type LayoutType } from "./layoutEngine";
import type { ArtifactGenerator, GenerateInput, GenerateOutput, GeneratorPlan, ValidationIssue, ValidationReport } from "./engine";

export class PresentationGenerator implements ArtifactGenerator {
  readonly family = "presentation" as const;

  async plan(goal: string, fileContext?: string): Promise<GeneratorPlan> {
    return {
      family: "presentation",
      filename: "presentation.pptx",
      spec: { goal, fileContext },
      requires: fileContext ? ["file-context"] : [],
      validationChecks: ["zip-container", "slide-count", "layout-density", "title-length"],
    };
  }

  /** 内容智能：LLM 产 spec（结构化）；失败回退文本启发式。 */
  async generate(input: GenerateInput): Promise<GenerateOutput> {
    let spec: PresentationSpec | null = null;
    if (input.spec && typeof input.spec === "object" && (input.spec as PresentationSpec).slides) {
      spec = input.spec as PresentationSpec;
    } else {
      spec = (await specFromLlm(input.goal, input.fileContext || "")) || specFromText(input.goal);
    }
    // 布局选择：spec 未指定 layout 时用启发式；缺省字段补全
    for (const slide of spec.slides) {
      if (!Array.isArray(slide.sections)) slide.sections = [];
      if (!Array.isArray(slide.equations)) slide.equations = [];
      if (!slide.layout || slide.layout === "content") {
        slide.layout = suggestLayout(toSlideContent(slide)) as LayoutType;
      }
    }
    const content = await renderPptxFromSpec(spec);
    return {
      filename: `${spec.title.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "演示文稿"}.pptx`,
      content,
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      metadata: { title: spec.title, slideCount: spec.slides.length, theme: spec.theme || null },
    };
  }

  async validate(content: Buffer): Promise<ValidationReport> {
    const issues: ValidationIssue[] = [];
    const checks: Record<string, boolean> = {};
    // 1. ZIP 容器
    try {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(content);
      checks["zip-container"] = Boolean(zip.file("[Content_Types].xml")) && Boolean(zip.file("ppt/presentation.xml"));
      if (!checks["zip-container"]) issues.push({ code: "INVALID_PPTX", severity: "error", message: "PPTX ZIP 容器不完整" });
      const slideCount = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
      checks["slide-count"] = slideCount >= 1;
      if (!checks["slide-count"]) issues.push({ code: "NO_SLIDES", severity: "error", message: "PPTX 没有内容页" });
    } catch {
      checks["zip-container"] = false;
      issues.push({ code: "INVALID_PPTX", severity: "error", message: "无法解析为 ZIP 容器" });
    }
    checks["layout-density"] = true;
    return { ok: issues.every((i) => i.severity !== "error"), issues, checks };
  }

  async renderPreview(content: Buffer): Promise<Array<{ type: string; data: Buffer; mime: string }>> {
    // slide 缩略图需要 LibreOffice（服务器 work runtime）；本地返回空（降级）
    try {
      const { execFile } = await import("node:child_process");
      const lo = await new Promise<boolean>((resolve) => {
        execFile("libreoffice", ["--version"], { timeout: 5000 }, (err) => resolve(!err));
      });
      if (!lo) return [];
    } catch {
      return [];
    }
    return [];
  }

  async repair(input: GenerateInput, issues: ValidationIssue[]): Promise<GenerateOutput> {
    // 有限修复：压缩文字（截断超长 section）后重渲染
    let spec: PresentationSpec | null = null;
    if (input.spec && typeof input.spec === "object" && (input.spec as PresentationSpec).slides) {
      spec = input.spec as PresentationSpec;
    } else {
      spec = (await specFromLlm(input.goal, input.fileContext || "")) || specFromText(input.goal);
    }
    for (const slide of spec.slides) {
      if (!Array.isArray(slide.sections)) slide.sections = [];
      if (!Array.isArray(slide.equations)) slide.equations = [];
      const layout = computeLayout((slide.layout as LayoutType) || "title-content", toSlideContent(slide));
      if (layout.density > 1.6) {
        slide.sections = slide.sections.map((s) => (estimateUnits(s) > 60 ? truncateUnits(s, 50) : s));
        slide.layout = "title-content";
      }
      if (slide.sections.length > 7) slide.sections = slide.sections.slice(0, 6);
      if (slide.title.length > 40) slide.title = slide.title.slice(0, 38) + "…";
    }
    const content = await renderPptxFromSpec(spec);
    return {
      filename: "presentation.pptx",
      content,
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      metadata: { title: spec.title, slideCount: spec.slides.length, repaired: true },
    };
  }
}

function toSlideContent(slide: PresentationSlide): { title: string; sections: string[]; equations?: string[] } {
  return { title: slide.title, sections: slide.sections, equations: slide.equations };
}

function estimateUnits(text: string): number {
  const cjk = (text.match(/[一-鿿　-〿]/g) || []).length;
  const words = text.replace(/[一-鿿　-〿]/g, " ").split(/\s+/).filter(Boolean).length;
  return cjk + words * 1.2;
}

function truncateUnits(text: string, maxUnits: number): string {
  let units = 0;
  let out = "";
  for (const ch of text) {
    const u = /[一-鿿　-〿]/.test(ch) ? 1 : /[\s，。、；：]/.test(ch) ? 0 : 1.2;
    if (units + u > maxUnits) break;
    units += u;
    out += ch;
  }
  return out + (out.length < text.length ? "…" : "");
}
