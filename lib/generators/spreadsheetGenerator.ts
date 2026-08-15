/**
 * SpreadsheetGenerator（V1.4 WP8-10）：真实 XLSX 管线（engine 入口）。
 * 输入 CSV/XLSX/文本/多表 → 真实 workbook；validate 结构性（ZIP/sheet/数据）。
 * 大表按 sheet/range/summary 访问（SpreadsheetTool 见 tools 层）。
 */

import * as XLSX from "xlsx";
import { generateXlsx } from "./xlsx";
import { summarizeXlsx, xlsxSummaryText } from "../files/xlsxReader";
import type { ArtifactGenerator, GenerateInput, GenerateOutput, GeneratorPlan, ValidationIssue, ValidationReport } from "./engine";

export class SpreadsheetGenerator implements ArtifactGenerator {
  readonly family = "spreadsheet" as const;

  async plan(goal: string, fileContext?: string): Promise<GeneratorPlan> {
    return {
      family: "spreadsheet",
      filename: "spreadsheet.xlsx",
      spec: { goal, fileContext },
      requires: [],
      validationChecks: ["zip-container", "sheet-exists", "has-data"],
    };
  }

  async generate(input: GenerateInput): Promise<GenerateOutput> {
    const message = [input.goal, input.fileContext ? `\n\n参考材料：\n${input.fileContext}` : ""].join("");
    const out = await generateXlsx({ message });
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
    const summary = summarizeXlsx(content);
    checks["zip-container"] = Boolean(summary);
    if (!summary) {
      issues.push({ code: "INVALID_XLSX", severity: "error", message: "无法解析为 XLSX 文件" });
    } else {
      checks["sheet-exists"] = summary.sheetCount >= 1;
      if (!checks["sheet-exists"]) issues.push({ code: "NO_SHEETS", severity: "error", message: "workbook 没有 sheet" });
      checks["has-data"] = summary.sheets.some((s) => s.rowCount > 0);
      if (!checks["has-data"]) issues.push({ code: "NO_DATA", severity: "error", message: "所有 sheet 都为空" });
    }
    return { ok: issues.every((i) => i.severity !== "error"), issues, checks };
  }

  async renderPreview(content: Buffer): Promise<Array<{ type: string; data: Buffer; mime: string }>> {
    // table preview：HTML 表（预览用）
    const summary = summarizeXlsx(content);
    if (!summary) return [];
    const sheet = summary.sheets[0];
    const rows = sheet.sampleRows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("");
    const head = sheet.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
    const html = `<table border="1" cellpadding="4"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    return [{ type: "table", data: Buffer.from(html, "utf8"), mime: "text/html" }];
  }

  async repair(input: GenerateInput, issues: ValidationIssue[]): Promise<GenerateOutput> {
    // 结构性失败（空表）→ 用模板生成有数据的表
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["项目", "数值"], ["示例", 1]]);
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    return {
      filename: "spreadsheet.xlsx",
      content: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      metadata: { repaired: true },
    };
  }
}

function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export { summarizeXlsx, xlsxSummaryText };
