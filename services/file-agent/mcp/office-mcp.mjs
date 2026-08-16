/**
 * office-mcp：Go AI Office 工具箱（Claude Code 的真实文件能力）。
 * Claude Code 决定内容与组织（spec/rows/markdown），本工具负责物理文件格式：
 *   office.presentation(spec_json, output_path) → 真实 .pptx（pptxgenjs）
 *   office.spreadsheet(sheets_json, output_path) → 真实 .xlsx
 *   office.document(markdown, output_path)       → 真实 .docx
 *   office.pdf(html, output_path)                → 真实 .pdf（chromium）
 *   office.validate(path)                        → 格式校验（pptx/xlsx/docx/pdf 结构）
 */

import path from "node:path";
import fs from "node:fs";
import { createMcpServer } from "./mcp-lite.mjs";

async function renderPptx(spec) {
  const { renderPptxFromSpec } = await import("../lib/generators/pptxRenderer");
  const { specFromJson } = await import("../lib/generators/presentationSpec");
  const parsed = specFromJson(spec);
  return renderPptxFromSpec(parsed);
}

async function renderXlsx(sheets) {
  const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));
  const wb = XLSX.utils.book_new();
  const list = Array.isArray(sheets) ? sheets : [{ name: "Sheet1", rows: sheets }];
  for (const s of list) {
    const rows = Array.isArray(s.rows) ? s.rows : [];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, String(s.name || "Sheet1").slice(0, 31));
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

async function renderDocx(markdown) {
  const { generateDocx } = await import("../lib/generators/docx");
  const { GeneratorError } = await import("../lib/generators/types");
  return generateDocx({ message: markdown }).catch((e) => {
    if (e instanceof GeneratorError) throw e;
    throw new Error("DOCX 渲染失败：" + (e instanceof Error ? e.message : String(e)));
  });
}

async function renderPdf(html) {
  const { renderPdfFromHtml } = await import("../lib/generators/pdfGenerator");
  const buf = await renderPdfFromHtml(html);
  if (!buf) throw new Error("PDF 渲染失败（chromium 不可用）");
  return buf;
}

async function validateFile(filePath) {
  const { validateArtifactFormat } = await import("../lib/artifacts/validator");
  const ext = path.extname(filePath).toLowerCase();
  const kind = { ".pptx": "pptx", ".xlsx": "xlsx", ".docx": "docx", ".pdf": "pdf" }[ext];
  if (!kind) return { ok: false, error: `不支持校验的格式：${ext}` };
  const buf = fs.readFileSync(filePath);
  const result = await validateArtifactFormat(filePath, path.basename(filePath), kind, buf);
  return result || { ok: true };
}

const str = { type: "string" };

const tools = [
  {
    name: "office.presentation",
    description: "生成真实 .pptx 文件。参数 spec 为结构化演示文稿描述：{title, slides:[{title, sections:[{heading, bullets[]}], equations[]}]}；output_path 为输出文件路径（相对 workspace）。",
    inputSchema: {
      type: "object",
      properties: { spec: { type: "object", description: "PresentationSpec JSON" }, output_path: str },
      required: ["spec", "output_path"],
    },
    handler: async ({ spec, output_path }) => {
      if (!output_path) throw new Error("output_path 必填");
      if (!/\.pptx$/i.test(output_path)) output_path += ".pptx";
      const buf = await renderPptx(spec);
      fs.writeFileSync(output_path, buf);
      return { ok: true, file: output_path, bytes: buf.length, slides: spec?.slides?.length || 0 };
    },
  },
  {
    name: "office.spreadsheet",
    description: "生成真实 .xlsx 文件。sheets 为工作表数组 [{name, rows:[[...]]}]（rows 为二维数组，首行可作表头）；output_path 为输出路径。",
    inputSchema: {
      type: "object",
      properties: { sheets: { type: "array", description: "工作表数组" }, output_path: str },
      required: ["sheets", "output_path"],
    },
    handler: async ({ sheets, output_path }) => {
      if (!output_path) throw new Error("output_path 必填");
      if (!/\.xlsx$/i.test(output_path)) output_path += ".xlsx";
      const buf = await renderXlsx(sheets);
      fs.writeFileSync(output_path, buf);
      return { ok: true, file: output_path, bytes: buf.length, sheets: Array.isArray(sheets) ? sheets.length : 1 };
    },
  },
  {
    name: "office.document",
    description: "生成真实 .docx 文件。markdown 为文档内容（标题/段落/列表/表格/引用）；output_path 为输出路径。",
    inputSchema: {
      type: "object",
      properties: { markdown: str, output_path: str },
      required: ["markdown", "output_path"],
    },
    handler: async ({ markdown, output_path }) => {
      if (!output_path) throw new Error("output_path 必填");
      if (!/\.docx$/i.test(output_path)) output_path += ".docx";
      const buf = await renderDocx(String(markdown || ""));
      fs.writeFileSync(output_path, buf);
      return { ok: true, file: output_path, bytes: buf.length };
    },
  },
  {
    name: "office.pdf",
    description: "生成真实 .pdf 文件。html 为完整 HTML 文档（含样式，A4 打印）；output_path 为输出路径。",
    inputSchema: {
      type: "object",
      properties: { html: str, output_path: str },
      required: ["html", "output_path"],
    },
    handler: async ({ html, output_path }) => {
      if (!output_path) throw new Error("output_path 必填");
      if (!/\.pdf$/i.test(output_path)) output_path += ".pdf";
      const buf = await renderPdf(String(html || ""));
      fs.writeFileSync(output_path, buf);
      return { ok: true, file: output_path, bytes: buf.length };
    },
  },
  {
    name: "office.validate",
    description: "校验文件是否为真实合法格式（pptx/xlsx/docx/pdf 结构检查）。返回 ok/错误明细。",
    inputSchema: {
      type: "object",
      properties: { path: str },
      required: ["path"],
    },
    handler: async ({ path: filePath }) => validateFile(filePath),
  },
];

createMcpServer({ name: "office-mcp", version: "1.0.0", tools });
