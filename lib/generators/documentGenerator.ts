/**
 * DocumentGenerator（V1.4 WP11）：真实 DOCX 管线（engine 入口）。
 * MD/TXT/材料 → DOCX（heading/paragraph/list/table/基本样式）。
 * validate：ZIP 容器 + word/document.xml。
 */

import { generateDocx } from "./docx";
import type { ArtifactGenerator, GenerateInput, GenerateOutput, GeneratorPlan, ValidationIssue, ValidationReport } from "./engine";

export class DocumentGenerator implements ArtifactGenerator {
  readonly family = "document" as const;

  async plan(goal: string, fileContext?: string): Promise<GeneratorPlan> {
    return {
      family: "document",
      filename: "document.docx",
      spec: { goal, fileContext },
      requires: [],
      validationChecks: ["zip-container", "document-xml"],
    };
  }

  async generate(input: GenerateInput): Promise<GenerateOutput> {
    const message = [input.goal, input.fileContext ? `\n\n参考材料：\n${input.fileContext}` : ""].join("");
    const out = await generateDocx({ message });
    return {
      filename: out.filename,
      content: out.content,
      mime: out.mime,
      metadata: {},
    };
  }

  async validate(content: Buffer): Promise<ValidationReport> {
    const issues: ValidationIssue[] = [];
    const checks: Record<string, boolean> = {};
    try {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(content);
      checks["zip-container"] = Boolean(zip.file("[Content_Types].xml"));
      checks["document-xml"] = Boolean(zip.file("word/document.xml"));
      if (!checks["zip-container"] || !checks["document-xml"]) {
        issues.push({ code: "INVALID_DOCX", severity: "error", message: "DOCX 容器不完整（缺 document.xml）" });
      }
    } catch {
      checks["zip-container"] = false;
      checks["document-xml"] = false;
      issues.push({ code: "INVALID_DOCX", severity: "error", message: "无法解析为 DOCX 文件" });
    }
    return { ok: issues.every((i) => i.severity !== "error"), issues, checks };
  }

  async renderPreview(content: Buffer): Promise<Array<{ type: string; data: Buffer; mime: string }>> {
    // 提取纯文本预览（docx 文本近似）
    try {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(content);
      const xml = await zip.file("word/document.xml")?.async("string");
      if (xml) {
        const text = xml
          .replace(/<w:tab[^>]*\/>/g, "\t")
          .replace(/<w:br[^>]*\/>/g, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        return [{ type: "text", data: Buffer.from(text.slice(0, 20_000), "utf8"), mime: "text/plain" }];
      }
    } catch {}
    return [];
  }

  async repair(input: GenerateInput, issues: ValidationIssue[]): Promise<GenerateOutput> {
    // 结构性失败 → 重新生成（确定性模板内容）
    return this.generate({ ...input, goal: input.goal, fileContext: input.fileContext });
  }
}
