/**
 * WebGenerator（V1.4 WP3）：真实 HTML 管线（engine 入口）。
 * 简单包装 → generator；按图/项目 → Agent（GeneratorBoundary 判定）。
 */

import { generateHtml } from "./html";
import type { ArtifactGenerator, GenerateInput, GenerateOutput, GeneratorPlan, ValidationIssue, ValidationReport } from "./engine";

export class WebGenerator implements ArtifactGenerator {
  readonly family = "webpage" as const;

  async plan(goal: string, fileContext?: string): Promise<GeneratorPlan> {
    return {
      family: "webpage",
      filename: "page.html",
      spec: { goal, fileContext },
      requires: [],
      validationChecks: ["html-structure", "non-empty"],
    };
  }

  async generate(input: GenerateInput): Promise<GenerateOutput> {
    const message = [input.goal, input.fileContext ? `\n\n参考材料：\n${input.fileContext}` : ""].join("");
    const out = await generateHtml({ message });
    return { filename: out.filename, content: out.content, mime: out.mime, metadata: {} };
  }

  async validate(content: Buffer): Promise<ValidationReport> {
    const issues: ValidationIssue[] = [];
    const checks: Record<string, boolean> = {};
    const html = content.toString("utf8");
    checks["non-empty"] = html.trim().length > 50;
    if (!checks["non-empty"]) issues.push({ code: "EMPTY_HTML", severity: "error", message: "HTML 内容为空" });
    checks["html-structure"] = /<html[\s>]/i.test(html) || /<!doctype html>/i.test(html);
    if (!checks["html-structure"]) issues.push({ code: "INVALID_HTML", severity: "error", message: "HTML 缺少文档结构" });
    // 基本闭合检查（<div> 配对近似）
    const opens = (html.match(/<div[\s>]/g) || []).length;
    const closes = (html.match(/<\/div>/g) || []).length;
    checks["balanced-divs"] = opens === closes;
    if (!checks["balanced-divs"]) issues.push({ code: "UNBALANCED_HTML", severity: "error", message: `div 标签不配对（${opens}/${closes}）` });
    return { ok: issues.every((i) => i.severity !== "error"), issues, checks };
  }

  async renderPreview(content: Buffer): Promise<Array<{ type: string; data: Buffer; mime: string }>> {
    return [{ type: "html", data: content, mime: "text/html" }];
  }

  async repair(input: GenerateInput, issues: ValidationIssue[]): Promise<GenerateOutput> {
    // 结构修复：补全 doctype/html 包裹
    const out = await this.generate(input);
    let html = out.content.toString("utf8");
    if (!/<!doctype html>/i.test(html)) html = `<!doctype html>\n${html}`;
    if (!/<html[\s>]/i.test(html)) html = `<html><head><meta charset="utf-8"><title>页面</title></head><body>${html}</body></html>`;
    return { ...out, content: Buffer.from(html, "utf8") };
  }
}
