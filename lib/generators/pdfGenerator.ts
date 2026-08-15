/**
 * PDF Pipeline（V1.4 WP12）：
 * 生成：HTML/文本 → PDF（playwright chromium page.pdf；本地/服务器可用）
 * 读取：PDF → text/pages/metadata（pdfjs-dist；必要页可转图走 vision）
 */

import type { ArtifactGenerator, GenerateInput, GenerateOutput, GeneratorPlan, ValidationIssue, ValidationReport } from "./engine";

export class PdfGenerator implements ArtifactGenerator {
  readonly family = "pdf" as const;

  async plan(goal: string, fileContext?: string): Promise<GeneratorPlan> {
    return {
      family: "pdf",
      filename: "document.pdf",
      spec: { goal, fileContext },
      requires: [],
      validationChecks: ["pdf-header", "non-empty"],
    };
  }

  async generate(input: GenerateInput): Promise<GenerateOutput> {
    // 内容智能：结构化 HTML（LLM 或输入上下文）
    const body = input.fileContext || input.goal;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body { font-family: "Microsoft YaHei", system-ui, sans-serif; margin: 40px; color: #1e293b; line-height: 1.6; }
      h1 { font-size: 24px; } h2 { font-size: 18px; margin-top: 24px; }
      table { border-collapse: collapse; width: 100%; margin: 12px 0; }
      td, th { border: 1px solid #cbd5e1; padding: 6px 10px; font-size: 13px; }
      pre { background: #f1f5f9; padding: 10px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
    </style></head><body>${toHtml(body)}</body></html>`;
    const content = await renderPdfFromHtml(html);
    if (!content) throw new Error("PDF_RENDER_FAILED：playwright chromium 不可用");
    return {
      filename: "document.pdf",
      content,
      mime: "application/pdf",
      metadata: { source: "html-render" },
    };
  }

  async validate(content: Buffer): Promise<ValidationReport> {
    const issues: ValidationIssue[] = [];
    const checks: Record<string, boolean> = {};
    checks["pdf-header"] = content.subarray(0, 5).toString() === "%PDF-";
    if (!checks["pdf-header"]) issues.push({ code: "INVALID_PDF", severity: "error", message: "不是合法 PDF（缺 %PDF 头）" });
    checks["non-empty"] = content.length > 500;
    if (!checks["non-empty"]) issues.push({ code: "EMPTY_PDF", severity: "error", message: "PDF 内容为空" });
    return { ok: issues.every((i) => i.severity !== "error"), issues, checks };
  }

  async renderPreview(content: Buffer): Promise<Array<{ type: string; data: Buffer; mime: string }>> {
    // 首页转 PNG（pdfjs 渲染）；失败降级返回 PDF 原文
    try {
      const { renderPdfFirstPage } = await import("../files/pdfReader");
      const png = await renderPdfFirstPage(content);
      if (png) return [{ type: "page-preview", data: png, mime: "image/png" }];
    } catch {}
    return [{ type: "pdf", data: content, mime: "application/pdf" }];
  }

  async repair(input: GenerateInput, issues: ValidationIssue[]): Promise<GenerateOutput> {
    return this.generate(input);
  }
}

/** 文本/Markdown → 简单 HTML（行内表/代码块保留）。 */
function toHtml(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  let inTable: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      if (inCode) { out.push("</pre>"); inCode = false; }
      else { out.push("<pre>"); inCode = true; }
      continue;
    }
    if (inCode) { out.push(esc(trimmed)); continue; }
    if (trimmed.startsWith("|")) {
      inTable.push(trimmed);
      continue;
    }
    if (inTable.length) {
      out.push(renderTable(inTable));
      inTable = [];
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      const level = trimmed.match(/^(#{1,6})/)?.[1].length || 2;
      out.push(`<h${level}>${esc(trimmed.replace(/^#{1,6}\s*/, ""))}</h${level}>`);
    } else if (/^[-*+]\s/.test(trimmed)) {
      out.push(`<li>${esc(trimmed.replace(/^[-*+]\s*/, ""))}</li>`);
    } else if (trimmed) {
      out.push(`<p>${esc(trimmed)}</p>`);
    }
  }
  if (inTable.length) out.push(renderTable(inTable));
  if (inCode) out.push("</pre>");
  return out.join("");
}

function renderTable(rows: string[]): string {
  const parsed = rows
    .filter((r) => !/^\|[\s:|-]+\|$/.test(r))
    .map((r) => r.split("|").slice(1, -1).map((c) => c.trim()).map(esc));
  if (!parsed.length) return "";
  const head = parsed[0];
  return `<table><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr>${parsed.slice(1).map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** HTML → PDF（playwright；无浏览器返回 null 降级）。 */
export async function renderPdfFromHtml(html: string, options?: { landscape?: boolean }): Promise<Buffer | null> {
  try {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle", timeout: 20_000 });
      const buf = await page.pdf({ format: "A4", printBackground: true, landscape: options?.landscape });
      return Buffer.from(buf);
    } finally {
      await browser.close();
    }
  } catch {
    return null;
  }
}
