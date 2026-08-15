/** LLM 内容管线测试：LLM 风格 Markdown 输入 → 各生成器正确渲染（F18 回归）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateXlsx } from "../../lib/generators/xlsx";
import { generateCsv } from "../../lib/generators/csv";
import { generateMarkdown } from "../../lib/generators/markdown";
import { generateHtml } from "../../lib/generators/html";
import { generatePptx } from "../../lib/generators/pptx";
import { llmArtifactContent } from "../../lib/generators/llm";
import * as XLSX from "xlsx";
import JSZip from "jszip";

const LLM_XLSX_CONTENT = `| 月份 | 销售额（元） | 环比 |
| --- | --- | --- |
| 1月 | 12000 | — |
| 2月 | 15000 | +25% |
| 3月 | 9800 | -35% |`;

const LLM_PPTX_CONTENT = `# 销售数据分析
## 一季度概览
- 总销售额 3.68 万元
- 2 月为峰值
## 趋势
- 1 月起步 1.2 万
- 3 月回落`;

const LLM_DOC_CONTENT = `# 销售报告
## 数据概览
- 3 个月共 3 个月度数据
## 结论
- 2 月销售最高`;

test("xlsx 生成器渲染 LLM 表格内容 → 读回行列一致", async () => {
  const output = await generateXlsx({ message: LLM_XLSX_CONTENT } as never);
  assert.equal(output.kind, "xlsx");
  const workbook = XLSX.read(output.content as Buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
  assert.equal(rows.length, 4, "表头 + 3 数据行");
  assert.deepEqual(rows[0], ["月份", "销售额（元）", "环比"]);
  assert.deepEqual(rows[1], ["1月", "12000", "—"]);
});

test("csv 生成器渲染 LLM 表格内容", async () => {
  const output = await generateCsv({ message: LLM_XLSX_CONTENT } as never);
  const text = output.content.toString("utf8");
  assert.match(text, /月份/);
  assert.match(text, /2月/);
});

test("markdown 生成器渲染 LLM 文档内容", async () => {
  const output = await generateMarkdown({ message: LLM_DOC_CONTENT } as never);
  const text = output.content.toString("utf8");
  assert.match(text, /^# 销售报告/m);
  assert.match(text, /## 数据概览/);
  assert.match(text, /- 2 月销售最高/);
});

test("html 生成器渲染 LLM 文档内容（自包含+转义）", async () => {
  const output = await generateHtml({ message: LLM_DOC_CONTENT } as never);
  const text = output.content.toString("utf8");
  assert.match(text, /<h1>销售报告<\/h1>/);
  assert.match(text, /<h2>数据概览<\/h2>/);
  assert.match(text, /由 Go AI 生成/);
});

test("pptx 生成器渲染 LLM 提纲内容 → 幻灯片数与页标题正确", async () => {
  const output = await generatePptx({ message: LLM_PPTX_CONTENT } as never);
  assert.equal(output.kind, "pptx");
  const zip = await JSZip.loadAsync(output.content as Buffer);
  const slideFiles = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slideFiles.length, 2, "两页内容页（V1.4 起无独立封面页）");
  const slide1 = await zip.file("ppt/slides/slide1.xml")?.async("string");
  assert.match(slide1 || "", /一季度概览/);
  const slide2 = await zip.file("ppt/slides/slide2.xml")?.async("string");
  assert.match(slide2 || "", /趋势/);
});

test("llmArtifactContent：未配置 LLM 时返回 null（回退路径）", async () => {
  const originalDs = process.env.DEEPSEEK_API_KEY;
  const originalOg = process.env.OPENCODE_GO_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  try {
    const result = await llmArtifactContent("xlsx", "整理表格", "材料");
    assert.equal(result, null);
  } finally {
    if (originalDs) process.env.DEEPSEEK_API_KEY = originalDs;
    if (originalOg) process.env.OPENCODE_GO_API_KEY = originalOg;
  }
});
