/** XLSX 生成器：从 message 提取数据（markdown 表格 / CSV 行 / 文本行）生成真实 .xlsx。 */

import * as XLSX from "xlsx";
import type { ArtifactGenerator, GeneratorOutput } from "./types";

function extractSheetData(message: string): string[][] {
  const lines = message.split("\n").map((line) => line.trim());

  // 1. markdown 表格
  const tableRows = lines.filter((line) => /^\|.*\|$/.test(line));
  if (tableRows.length >= 2) {
    return tableRows
      .map((row) => row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()))
      .filter((row) => !row.every((cell) => /^-+$/.test(cell)));
  }

  // 2. CSV / 制表符分隔行
  const dataLines = lines.filter((line) => line && (line.includes(",") || line.includes("\t") || line.includes("，")));
  if (dataLines.length) {
    return dataLines.map((line) => line.split(/[,，\t]/).map((cell) => cell.trim()));
  }

  // 3. 兜底：单列文本
  const textLines = lines.filter((line) => line && !/^(#{1,6}\s|[-*] )/.test(line));
  return [["内容"], ...textLines.map((line) => [line.replace(/^[-*]\s*/, "")])];
}

export const generateXlsx: ArtifactGenerator = async (input) => {
  const data = extractSheetData(input.message);
  const worksheet = XLSX.utils.aoa_to_sheet(data);
  // 首行加粗表头样式（基础样式）
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
  const content = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return {
    filename: "表格.xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: "xlsx",
    content: Buffer.from(content)
  };
};
