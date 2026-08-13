import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeCell, generateCsv, toCsv } from "../../lib/generators/csv";

test("1. 含逗号的多行 → 按表输出（首行表头）", async () => {
  const out = await generateCsv({ message: "导出 csv：\n名字,年龄\n张三,28\n李四,30" });
  assert.equal(out.kind, "csv");
  assert.equal(out.mime, "text/csv");
  assert.match(out.filename, /\.csv$/);
  const csv = out.content.toString("utf8");
  assert.ok(csv.startsWith("名字,年龄\r\n"));
  assert.ok(csv.includes("张三,28"));
});

test("2. 公式注入防护：= + - @ 前缀加撇号", () => {
  assert.equal(escapeCell("=SUM(A1:A9)"), '"\'=SUM(A1:A9)"');
  assert.equal(escapeCell("+1+1"), "\"'+1+1\"");
  assert.equal(escapeCell("@cmd"), "\"'@cmd\"");
  assert.equal(escapeCell("-5"), "\"'-5\"");
  assert.equal(escapeCell("5"), "5");
  const csv = toCsv([["a", "b"], ["=1+1", "正常"]]);
  assert.ok(!csv.includes(",=1+1"), "公式不应原样出现");
  assert.ok(csv.includes("'=1+1"), "公式应被撇号前缀");
});

test("3. 引号/逗号/换行转义", () => {
  const csv = toCsv([['he said "hi"', "a,b", "line1\nline2"]]);
  assert.ok(csv.includes('"he said ""hi"""'));
  assert.ok(csv.includes('"a,b"'));
  assert.ok(csv.includes('"line1\nline2"'));
});

test("4. 无逗号输入 → 键值表", async () => {
  const out = await generateCsv({ message: "表格：主题：Go AI。负责人：张三。进度：80%。" });
  const csv = out.content.toString("utf8");
  assert.ok(csv.includes("负责人,张三"));
  assert.ok(csv.includes("进度,80%"));
});
