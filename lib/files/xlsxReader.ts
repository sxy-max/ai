/**
 * XLSX Reader（V1.2 WP16）：把 xlsx 输入解析为结构化摘要（sheets/columns/rows），
 * 供 executor 的 fileSummaries 与 planner 使用（Agent 仍可读取原文件）。
 * 不引入重依赖：复用现有 SheetJS（xlsx 包）。
 */

import * as XLSX from "xlsx";

export type XlsxSheetSummary = {
  name: string;
  columns: string[];
  rowCount: number;
  sampleRows: string[][];
};

export type XlsxSummary = {
  sheets: XlsxSheetSummary[];
  sheetCount: number;
};

const MAX_SAMPLE_ROWS = 3;
const MAX_COLUMNS = 30;

/** 解析 xlsx buffer → 结构化摘要；失败返回 null（调用方降级为二进制提示）。 */
export function summarizeXlsx(buf: Buffer): XlsxSummary | null {
  try {
    const workbook = XLSX.read(buf, { type: "buffer" });
    const sheets: XlsxSheetSummary[] = [];
    for (const name of workbook.SheetNames.slice(0, 8)) {
      const sheet = workbook.Sheets[name];
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: true, defval: "" }) as string[][];
      if (!rows.length) continue;
      const columns = (rows[0] || []).map(String).slice(0, MAX_COLUMNS);
      sheets.push({
        name: String(name),
        columns,
        rowCount: Math.max(rows.length - 1, 0),
        sampleRows: rows.slice(1, 1 + MAX_SAMPLE_ROWS).map((r) => r.slice(0, MAX_COLUMNS).map(String)),
      });
    }
    if (!sheets.length) return null;
    return { sheets, sheetCount: sheets.length };
  } catch {
    return null;
  }
}

/** 摘要转文本（fileSummaries 注入用）。 */
export function xlsxSummaryText(summary: XlsxSummary): string {
  const lines = summary.sheets.map((s) => {
    const head = `- sheet「${s.name}」：${s.rowCount} 行 × ${s.columns.length} 列`;
    const cols = s.columns.length ? `  列：${s.columns.join("、")}` : "";
    const sample = s.sampleRows.length
      ? `  样例：${s.sampleRows.map((r) => r.join(" | ")).join(" ／ ")}`
      : "";
    return `${head}${cols ? `\n${cols}` : ""}${sample ? `\n${sample}` : ""}`;
  });
  return `XLSX 结构：\n${lines.join("\n")}`;
}
