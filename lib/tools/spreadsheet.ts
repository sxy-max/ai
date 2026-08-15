/**
 * SpreadsheetTool（V1.4 WP9）：真实 workbook 操作工具（exceljs）。
 * 大表按 sheet/range/summary 访问——绝不整份转 Markdown 让模型操作。
 * 工具：read_workbook/list_sheets/read_range/write_range/add_sheet/delete_sheet/
 *        sort_range/filter_rows/create_formula/create_chart/format_cells/save_workbook。
 */

import ExcelJS from "exceljs";
import { artifactService } from "../artifacts/service";
import type { AgentTool, ToolExecutionContext, ToolResult } from "../tools/registry";

/* ---------- 核心操作（无副作用；内容在内存 workbook） ---------- */

export type WorkbookHandle = { artifactId: string; workbook: ExcelJS.Workbook; path: string };

/** exceljs cell.col 是 Column 对象：取数字列号。 */
/** exceljs 的 cell.col / cell.row 就是数字（类型定义过时，运行时为 number）。 */
function colNum(cell: ExcelJS.Cell): number {
  return typeof cell.col === "number" ? cell.col : Number(cell.col);
}

function rowNum(cell: ExcelJS.Cell): number {
  return typeof cell.row === "number" ? cell.row : Number(cell.row);
}

/** 从 ArtifactService 读 workbook。 */
export async function openWorkbook(artifactId: string): Promise<WorkbookHandle | null> {
  try {
    const raw = artifactService.readContent(artifactId);
    if (!raw) return null;
    const buf = Buffer.from(raw.buffer as ArrayBuffer, raw.byteOffset, raw.byteLength);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buf as never);
    return { artifactId, workbook, path: artifactId };
  } catch {
    return null;
  }
}

/** 保存 workbook 回 ArtifactService（新 artifact 或覆盖同 id 内容）。 */
export async function saveWorkbook(handle: WorkbookHandle): Promise<{ artifactId: string; bytes: number }> {
  const writer = handle.workbook.xlsx as unknown as { writeBuffer: () => Promise<ArrayBuffer> };
  const buf = await writer.writeBuffer();
  // 新版本 artifact（版本化；Agent 用返回的新 id 继续操作）
  const artifact = artifactService.createArtifact({
    filename: `${handle.artifactId.slice(0, 8)}.xlsx`,
    content: Buffer.from(buf),
    kind: "xlsx",
    source: "agent",
    metadata: { parent: handle.artifactId },
  });
  return { artifactId: artifact.id, bytes: Buffer.byteLength(buf as never) };
}

/** workbook 摘要（sheets/行列数）。 */
export function workbookSummary(handle: WorkbookHandle): Record<string, unknown> {
  const sheets = handle.workbook.worksheets.map((ws) => ({
    name: ws.name,
    rowCount: ws.rowCount,
    columnCount: ws.columnCount,
    columns: ((ws.getRow(1).values as unknown as unknown[]) || []).slice(1).map(String).slice(0, 20),
  }));
  return { sheets, sheetCount: sheets.length };
}

/** 读 range（如 A1:D10）。 */
export function readRange(handle: WorkbookHandle, sheet: string, range: string, maxRows = 200): { columns: string[]; rows: string[][] } {
  const ws = handle.workbook.getWorksheet(sheet);
  if (!ws) throw new Error(`sheet 不存在: ${sheet}`);
  const [from, to] = range.split(":").map((c) => ws.getCell(c));
  const startCol = colNum(from), endCol = to ? colNum(to) : colNum(from) + 10;
  const startRow = rowNum(from), endRow = to ? Math.min(rowNum(to), rowNum(from) + maxRows) : Math.min(rowNum(from) + maxRows, ws.rowCount);
  const columns: string[] = [];
  const rows: string[][] = [];
  for (let r = startRow; r <= endRow; r++) {
    const row = ws.getRow(r);
    const values: string[] = [];
    for (let c = startCol; c <= endCol; c++) {
      const cell = row.getCell(c);
      const v = cell.value;
      values.push(typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? ""));
    }
    if (r === startRow) columns.push(...values);
    else rows.push(values);
  }
  return { columns, rows };
}

/** 写 range（二维数组）。 */
export function writeRange(handle: WorkbookHandle, sheet: string, range: string, values: string[][], maxRows = 500): void {
  const ws = handle.workbook.getWorksheet(sheet);
  if (!ws) throw new Error(`sheet 不存在: ${sheet}`);
  const [from] = range.split(":").map((c) => ws.getCell(c));
  const startCol = colNum(from), startRow = rowNum(from);
  for (let i = 0; i < Math.min(values.length, maxRows); i++) {
    for (let j = 0; j < values[i].length; j++) {
      const cell = ws.getCell(startRow + i, startCol + j);
      const raw = values[i][j];
      cell.value = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    }
  }
}

/** 排序 range（按列；asc/desc）。 */
export function sortRange(handle: WorkbookHandle, sheet: string, columnIndex: number, direction: "asc" | "desc", hasHeader = true): void {
  const ws = handle.workbook.getWorksheet(sheet);
  if (!ws) throw new Error(`sheet 不存在: ${sheet}`);
  const startRow = hasHeader ? 2 : 1;
  const maxCol = ws.columnCount;
  // 显式逐格快照（getCell，避开 exceljs eachCell 的行对象引用怪癖）
  const readRow = (r: number): unknown[] => {
    const vals: unknown[] = [];
    for (let c = 1; c <= maxCol; c++) vals.push(ws.getCell(r, c).value);
    return vals;
  };
  const rows: Array<{ rowNumber: number; key: number | string; values: unknown[] }> = [];
  for (let r = startRow; r <= ws.rowCount; r++) {
    const cell = ws.getCell(r, columnIndex);
    const v = cell.value;
    rows.push({ rowNumber: r, key: typeof v === "number" ? v : String(v ?? ""), values: readRow(r) });
  }
  rows.sort((a, b) => {
    const cmp = typeof a.key === "number" && typeof b.key === "number" ? a.key - b.key : String(a.key).localeCompare(String(b.key), "zh-CN");
    return direction === "asc" ? cmp : -cmp;
  });
  // 写回：先清目标行，再逐格写入（行号连续 from startRow）
  for (let r = startRow; r < startRow + rows.length; r++) {
    const target = ws.getRow(r);
    target.eachCell({ includeEmpty: true }, (cell) => { (cell as { value: unknown }).value = null; });
  }
  rows.forEach((row, i) => {
    const target = ws.getRow(startRow + i);
    row.values.forEach((v, idx) => {
      if (v !== undefined && v !== null) (target.getCell(idx + 1) as { value: unknown }).value = v;
    });
  });
}

/** 过滤行（列值匹配）。 */
export function filterRows(handle: WorkbookHandle, sheet: string, columnIndex: number, match: string, keepMatches = true): void {
  const ws = handle.workbook.getWorksheet(sheet);
  if (!ws) throw new Error(`sheet 不存在: ${sheet}`);
  for (let r = ws.rowCount; r >= 2; r--) {
    const v = String(ws.getCell(r, columnIndex).value ?? "");
    const hit = v.includes(match);
    if (hit !== keepMatches) ws.spliceRows(r, 1);
  }
}

/** 新增 sheet（带初始数据）。 */
export function addSheet(handle: WorkbookHandle, name: string, values?: string[][]): void {
  if (handle.workbook.getWorksheet(name)) throw new Error(`sheet 已存在: ${name}`);
  const ws = handle.workbook.addWorksheet(name);
  if (values?.length) writeRange(handle, name, "A1", values);
}

/** 删除 sheet。 */
export function deleteSheet(handle: WorkbookHandle, name: string): void {
  const ws = handle.workbook.getWorksheet(name);
  if (!ws) throw new Error(`sheet 不存在: ${name}`);
  handle.workbook.removeWorksheet(ws.id);
}

/** 公式（写入单元格）。 */
export function createFormula(handle: WorkbookHandle, sheet: string, cell: string, formula: string): void {
  const ws = handle.workbook.getWorksheet(sheet);
  if (!ws) throw new Error(`sheet 不存在: ${sheet}`);
  const c = ws.getCell(cell);
  c.value = { formula: formula.replace(/^=/, ""), result: undefined };
}

/** 图表（exceljs 支持柱状/折线；数据来自 range）。 */
export function createChart(handle: WorkbookHandle, sheet: string, name: string, options: { type: "bar" | "line" | "pie"; dataRange: string; labelsRange?: string }): void {
  const ws = handle.workbook.getWorksheet(sheet);
  if (!ws) throw new Error(`sheet 不存在: ${sheet}`);
  const [from, to] = options.dataRange.split(":").map((c) => ws.getCell(c));
  const cols = (to ? colNum(to) : colNum(from)) - colNum(from) + 1;
  const rows = (to ? rowNum(to) : rowNum(from)) - rowNum(from) + 1;
  const data: Array<{ name: string; values: number[] }> = [];
  for (let c = colNum(from); c <= colNum(from) + cols - 1; c++) {
    const series: number[] = [];
    for (let r = rowNum(from); r <= rowNum(from) + rows - 1; r++) {
      const v = ws.getCell(r, c).value;
      series.push(typeof v === "number" ? v : Number(v) || 0);
    }
    data.push({ name: `列${c - colNum(from) + 1}`, values: series });
  }
  // exceljs 社区版无原生图表 API：记录图表数据块（_charts sheet）供预览渲染
  const chartSheet = handle.workbook.getWorksheet("_charts") || handle.workbook.addWorksheet("_charts");
  chartSheet.getCell("A1").value = `CHART:${name} type=${options.type}`;
  chartSheet.getCell("A2").value = JSON.stringify({ type: options.type, dataRange: options.dataRange, labelsRange: options.labelsRange || null, data });
  void data;
}

/** 单元格格式（字体/背景/对齐/宽度）。 */
export function formatCells(handle: WorkbookHandle, sheet: string, range: string, format: { bold?: boolean; fill?: string; fontSize?: number; align?: "left" | "center" | "right" }): void {
  const ws = handle.workbook.getWorksheet(sheet);
  if (!ws) throw new Error(`sheet 不存在: ${sheet}`);
  const [from, to] = range.split(":").map((c) => ws.getCell(c));
  for (let r = rowNum(from); r <= (to ? rowNum(to) : rowNum(from)); r++) {
    for (let c = colNum(from); c <= (to ? colNum(to) : colNum(from)); c++) {
      const cell = ws.getCell(r, c);
      if (format.bold) cell.font = { ...(cell.font || {}), bold: true };
      if (format.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: format.fill.replace("#", "FF") } };
      if (format.fontSize) cell.font = { ...(cell.font || {}), size: format.fontSize };
      if (format.align) cell.alignment = { ...(cell.alignment || {}), horizontal: format.align };
    }
  }
}

/* ---------- AgentTool 注册（WP9） ---------- */

const SHEET_TOOL = (name: string, description: string, execute: AgentTool["execute"]): AgentTool => ({
  name,
  description,
  inputSchema: {},
  permission: "workspace",
  capabilities: [],
  execute,
});

export const SPREADSHEET_TOOLS: AgentTool[] = [
  SHEET_TOOL("spreadsheet.read_workbook", "读取 workbook 摘要（sheets/行列数/表头）", async (input, ctx) => {
    const handle = await openWorkbook(String(input.artifactId));
    if (!handle) return { ok: false, output: null, error: "无法打开 workbook" };
    try { return { ok: true, output: workbookSummary(handle) }; } finally { void handle; }
  }),
  SHEET_TOOL("spreadsheet.list_sheets", "列出 sheet 名称", async (input, ctx) => {
    const handle = await openWorkbook(String(input.artifactId));
    if (!handle) return { ok: false, output: null, error: "无法打开 workbook" };
    return { ok: true, output: handle.workbook.worksheets.map((ws) => ws.name) };
  }),
  SHEET_TOOL("spreadsheet.read_range", "读取指定 sheet 的 range（如 A1:D10）", async (input, ctx) => {
    const handle = await openWorkbook(String(input.artifactId));
    if (!handle) return { ok: false, output: null, error: "无法打开 workbook" };
    try { return { ok: true, output: readRange(handle, String(input.sheet), String(input.range)) }; } finally { void handle; }
  }),
  SHEET_TOOL("spreadsheet.write_range", "写入指定 sheet 的 range（二维数组）", async (input, ctx) => {
    const handle = await openWorkbook(String(input.artifactId));
    if (!handle) return { ok: false, output: null, error: "无法打开 workbook" };
    try {
      writeRange(handle, String(input.sheet), String(input.range), input.values as string[][]);
      const saved = await saveWorkbook(handle);
      return { ok: true, output: { saved, filesChanged: [String(input.artifactId)] } };
    } finally { void handle; }
  }),
  SHEET_TOOL("spreadsheet.add_sheet", "新增 sheet（可带初始数据）", async (input, ctx) => {
    const handle = await openWorkbook(String(input.artifactId));
    if (!handle) return { ok: false, output: null, error: "无法打开 workbook" };
    try {
      addSheet(handle, String(input.name), input.values as string[][] | undefined);
      const saved = await saveWorkbook(handle);
      return { ok: true, output: saved };
    } finally { void handle; }
  }),
  SHEET_TOOL("spreadsheet.sort_range", "按列排序（asc/desc，可选表头）", async (input, ctx) => {
    const handle = await openWorkbook(String(input.artifactId));
    if (!handle) return { ok: false, output: null, error: "无法打开 workbook" };
    try {
      sortRange(handle, String(input.sheet), Number(input.columnIndex), input.direction as "asc" | "desc", input.hasHeader !== false);
      const saved = await saveWorkbook(handle);
      return { ok: true, output: saved };
    } finally { void handle; }
  }),
  SHEET_TOOL("spreadsheet.filter_rows", "按列值过滤行（保留/删除匹配）", async (input, ctx) => {
    const handle = await openWorkbook(String(input.artifactId));
    if (!handle) return { ok: false, output: null, error: "无法打开 workbook" };
    try {
      filterRows(handle, String(input.sheet), Number(input.columnIndex), String(input.match), input.keepMatches !== false);
      const saved = await saveWorkbook(handle);
      return { ok: true, output: saved };
    } finally { void handle; }
  }),
  SHEET_TOOL("spreadsheet.create_formula", "写入公式（如 SUM(A1:A10)）", async (input, ctx) => {
    const handle = await openWorkbook(String(input.artifactId));
    if (!handle) return { ok: false, output: null, error: "无法打开 workbook" };
    try {
      createFormula(handle, String(input.sheet), String(input.cell), String(input.formula));
      const saved = await saveWorkbook(handle);
      return { ok: true, output: saved };
    } finally { void handle; }
  }),
  SHEET_TOOL("spreadsheet.create_chart", "创建数据图表（bar/line/pie，数据来自 range）", async (input, ctx) => {
    const handle = await openWorkbook(String(input.artifactId));
    if (!handle) return { ok: false, output: null, error: "无法打开 workbook" };
    try {
      createChart(handle, String(input.sheet), String(input.name), { type: input.type as "bar" | "line" | "pie", dataRange: String(input.dataRange), labelsRange: input.labelsRange ? String(input.labelsRange) : undefined });
      const saved = await saveWorkbook(handle);
      return { ok: true, output: saved };
    } finally { void handle; }
  }),
  SHEET_TOOL("spreadsheet.format_cells", "单元格格式（粗体/背景/字号/对齐）", async (input, ctx) => {
    const handle = await openWorkbook(String(input.artifactId));
    if (!handle) return { ok: false, output: null, error: "无法打开 workbook" };
    try {
      formatCells(handle, String(input.sheet), String(input.range), input.format as { bold?: boolean; fill?: string; fontSize?: number; align?: "left" | "center" | "right" });
      const saved = await saveWorkbook(handle);
      return { ok: true, output: saved };
    } finally { void handle; }
  }),
  SHEET_TOOL("spreadsheet.save_workbook", "保存 workbook（写回 ArtifactService）", async (input, ctx) => {
    const handle = await openWorkbook(String(input.artifactId));
    if (!handle) return { ok: false, output: null, error: "无法打开 workbook" };
    try { return { ok: true, output: await saveWorkbook(handle) }; } finally { void handle; }
  }),
];

export type { ToolExecutionContext, ToolResult };
