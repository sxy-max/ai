/** Spreadsheet Tool 测试（V1.4 WP8-10）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { artifactService } from "../../lib/artifacts/service";
import {
  openWorkbook, workbookSummary, readRange, writeRange, sortRange, filterRows,
  addSheet, deleteSheet, createFormula, createChart, formatCells, saveWorkbook,
} from "../../lib/tools/spreadsheet";

process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-artifacts-spreadsheet-test");

function makeWorkbook(): { artifactId: string; rows: string[][] } {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sales");
  const rows = [
    ["name", "score", "city"],
    ["alice", "30", "北京"],
    ["bob", "10", "上海"],
    ["carol", "20", "深圳"],
  ];
  rows.forEach((r, i) => ws.addRow(r));
  const artifactId = `wb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const buf = wb.xlsx.writeBuffer();
  // 同步落盘（测试简化：await 后写入）
  return { artifactId, rows };
}

test("read_workbook 摘要：sheets/行列数/表头", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("S");
  ws.addRow(["a", "b"]);
  ws.addRow([1, 2]);
  const buf = await wb.xlsx.writeBuffer();
  const id = artifactService.createArtifact({ filename: "t.xlsx", content: Buffer.from(buf), kind: "xlsx", source: "upload" }).id;
  const handle = await openWorkbook(id);
  assert.ok(handle);
  const summary = workbookSummary(handle!);
  assert.equal(summary.sheetCount, 1);
  assert.deepEqual((summary.sheets as Array<{ name: string; columns: string[] }>)[0].columns, ["a", "b"]);
});

test("排序 + 过滤 + 公式 + 新 sheet + 保存后重读验证（before/after）", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Data");
  const rows = [
    ["name", "score"],
    ["alice", "30"],
    ["bob", "10"],
    ["carol", "20"],
  ];
  rows.forEach((r) => ws.addRow(r));
  const buf = await wb.xlsx.writeBuffer();
  const id = artifactService.createArtifact({ filename: "s.xlsx", content: Buffer.from(buf), kind: "xlsx", source: "upload" }).id;

  const handle = await openWorkbook(id);
  assert.ok(handle);

  // before summary
  const before = readRange(handle!, "Data", "A1:B4");
  assert.equal(before.rows.length, 3);

  // 排序（第二列 asc）
  sortRange(handle!, "Data", 2, "asc", true);
  // 公式（合计）
  createFormula(handle!, "Data", "B5", "SUM(B2:B4)");
  // 新 sheet
  addSheet(handle!, "Stats", [["指标", "值"], ["总人数", "3"]]);
  // 图表数据块
  createChart(handle!, "Data", "分数", { type: "bar", dataRange: "B2:B4" });
  // 格式（表头粗体）
  formatCells(handle!, "Data", "A1:B1", { bold: true });
  await saveWorkbook(handle!);

  // after：重读验证（未破坏未要求区域）
  const after = readRange(handle!, "Data", "A1:B5");
  assert.equal(after.columns[0], "name");
  assert.deepEqual(after.rows[0], ["bob", "10"], "排序后 bob 应在第一行");
  assert.deepEqual(after.rows[2], ["alice", "30"], "alice 应在最后");
  assert.match(after.rows[3][1], /SUM/, "公式应写入 B5");
  assert.equal(workbookSummary(handle!).sheetCount, 3, "新增 Stats + _charts sheet");
  // 未要求区域（C 列）未被破坏——空
  const side = readRange(handle!, "Data", "C1:C4");
  assert.ok(side.rows.every((r) => r[0] === ""), "未要求区域不被修改");
});

test("过滤行 + 删除 sheet", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("D");
  ws.addRow(["city", "pop"]);
  ws.addRow(["北京", 100]);
  ws.addRow(["上海", 80]);
  ws.addRow(["广州", 60]);
  const buf = await wb.xlsx.writeBuffer();
  const id = artifactService.createArtifact({ filename: "f.xlsx", content: Buffer.from(buf), kind: "xlsx", source: "upload" }).id;
  const handle = await openWorkbook(id);
  assert.ok(handle);
  filterRows(handle!, "D", 1, "北京");
  const after = readRange(handle!, "D", "A1:B4");
  const nonEmpty = after.rows.filter((r) => r.some((v) => v !== ""));
  assert.equal(nonEmpty.length, 1, "过滤后应只剩北京一行");
  assert.equal(nonEmpty[0][0], "北京");
  addSheet(handle!, "Temp", [["x"]]);
  deleteSheet(handle!, "Temp");
  assert.equal(workbookSummary(handle!).sheetCount, 1);
  await saveWorkbook(handle!);
});

test("写入 range：数值识别（数字/文本）", async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("S").addRow(["a"]);
  const buf = await wb.xlsx.writeBuffer();
  const id = artifactService.createArtifact({ filename: "w.xlsx", content: Buffer.from(buf), kind: "xlsx", source: "upload" }).id;
  const handle = await openWorkbook(id);
  assert.ok(handle);
  writeRange(handle!, "S", "A2", [["42"], ["文本"]]);
  const read = readRange(handle!, "S", "A1:A3");
  assert.equal(read.rows[0][0], "42");
  assert.equal(read.rows[1][0], "文本");
  await saveWorkbook(handle!);
});
