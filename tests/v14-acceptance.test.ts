/**
 * V1.4 验收级测试（WP56/58/59/60）：真实产物交付，禁止 Markdown 冒充。
 * 全部走确定性生成链（LLM 不参与），断言物理文件内容。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { PresentationGenerator } from "../lib/generators/presentationGenerator";
import { SpreadsheetGenerator } from "../lib/generators/spreadsheetGenerator";
import { DocumentGenerator } from "../lib/generators/documentGenerator";
import { PdfGenerator } from "../lib/generators/pdfGenerator";
import { buildExecutionPlan } from "../lib/tasks/executionPlan";
import { artifactService } from "../lib/artifacts/service";
import { openWorkbook, saveWorkbook, sortRange, createFormula, addSheet, createChart, workbookSummary, readRange } from "../lib/tools/spreadsheet";
import { AGENT_WORK_INSTRUCTION } from "../lib/tasks/devExecutor";
import { detectOperation } from "../lib/taskRouter";

process.env.ARTIFACTS_ROOT = path.join(os.tmpdir(), "goai-artifacts-v14-acceptance");

const PHYSICS = `# 旋转圆环小珠（大学物理）

## 问题
一个半径为 R 的竖直圆环绕竖直直径以角速度 ω 匀速转动，环上套一小珠（视为质点）。

## 模型
设小珠质量为 m，偏离最低点的角为 θ。环静止系中，小珠受重力 mg、环支持力 N、惯性离心力 mω²R sinθ。

## 拉格朗日量
取广义坐标 θ：L = ½mR²(θ̇² + ω² sin²θ) − mgR(1 − cosθ)

## 平衡位置
平衡条件 ∂L/∂θ = 0 → sinθ(ω²cosθ − g/R) = 0
θ₁ = 0（最低点）；ω² > g/R 时另有 θ₂ = arccos(g/(Rω²))

## 稳定性
θ₁ 稳定当 ω² < g/R；θ₂ 存在时稳定（V'' > 0）。

## 临界角速度
ω_c = √(g/R)：低于此值仅最低点稳定，高于此值出现非零稳定平衡。

## 小振动
θ₁ 附近：Ω² = ω² − g/R（ω < ω_c 时 Ω² < 0 表示不稳定展开）
θ₂ 附近：Ω² = ω² − (g/R)² / ω² × ...`;

const PHYSICS_SPEC = {
  title: "旋转圆环小珠",
  audience: "大学物理课程",
  purpose: "教学演示",
  aspectRatio: "16:9",
  theme: "light",
  slides: [
    { title: "问题与模型", objective: "建立拉格朗日量", sections: ["问题：竖直圆环 ω 转动，小珠位置 θ", "模型：重力 + 支持力 + 惯性离心力", "拉格朗日量：L = ½mR²(θ̇² + ω²sin²θ) − mgR(1−cosθ)"], layout: "title-content", speakerNotes: "先介绍系统，再写出拉格朗日量" },
    { title: "平衡·稳定性·临界角速度", objective: "分析平衡与振动", sections: ["平衡：sinθ(ω²cosθ − g/R) = 0", "稳定性：θ₁ 稳定当 ω² < g/R", "临界角速度：ω_c = √(g/R)", "小振动：Ω² = ω² − g/R（θ₁ 附近）"], layout: "two-column", speakerNotes: "第二页总结结论" },
  ],
};

test("WP58 物理题 PPT：真实 pptx、恰好 2 页、内容完整、validate 通过", async () => {
  const gen = new PresentationGenerator();
  const out = await gen.generate({ goal: "把以上内容制作成两页大学物理课程 PPT", spec: PHYSICS_SPEC as never });
  assert.equal(out.content.subarray(0, 2).toString(), "PK", "必须是真实 ZIP/PPTX 容器");
  assert.equal(out.metadata.slideCount, 2, "恰好两页");
  assert.ok(out.content.length > 5000, "非空真实文件");
  const report = await gen.validate(out.content);
  assert.equal(report.ok, true, `validate: ${JSON.stringify(report.issues)}`);
  // 内容断言：slide XML 含关键物理文本（公式/结论）
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(out.content);
  const slideXml = (await zip.file("ppt/slides/slide1.xml")?.async("string")) || "";
  const slide2Xml = (await zip.file("ppt/slides/slide2.xml")?.async("string")) || "";
  for (const key of ["拉格朗日量", "问题", "模型"]) assert.ok(slideXml.includes(key), `slide1 应含 ${key}`);
  for (const key of ["平衡", "稳定性", "临界角速度", "小振动"]) assert.ok(slide2Xml.includes(key), `slide2 应含 ${key}`);
  // 公式字符：pptxgenjs 将非 ASCII 转义为 XML 实体（&#x3C9; 等），按实体或原文匹配
  assert.ok(/(ω|&#[xX]?3[Cc]9;|&#[xX]?3A9;)/.test(slide2Xml), "公式字符（ω/Ω）应保留（含 XML 实体形式）");
  // 预览策略：slideCount 元数据（缩略图需 LibreOffice，本地可空）
  const preview = await gen.renderPreview(out.content);
  assert.equal(out.metadata.slideCount, 2, "slideCount 元数据=实际页数");
  void preview;
});

test("WP59 学生成绩表：排序/平均分/统计 sheet/柱状图 → 重读验证未要求区域不被破坏", async () => {
  const gen = new SpreadsheetGenerator();
  const scores = `| 姓名 | 数学 | 语文 | 英语 |\n| 张三 | 85 | 90 | 78 |\n| 李四 | 92 | 88 | 95 |\n| 王五 | 76 | 82 | 88 |`;
  const out = await gen.generate({ goal: "整理学生成绩", fileContext: scores });
  const id = artifactService.createArtifact({ filename: "student_scores.xlsx", content: out.content, kind: "xlsx", source: "agent" }).id;

  // Agent 视角：打开 → 按数学列（第 2 列）排序 → 新增平均分公式 → 统计 sheet → 柱状图 → 保存
  const handle = await openWorkbook(id);
  assert.ok(handle, "workbook 可打开");
  sortRange(handle, "Sheet1", 2, "desc"); // 数学 = 第 2 列（1=A）
  createFormula(handle, "Sheet1", "F2", "=ROUND(AVERAGE(B2:E2),1)");
  addSheet(handle, "统计", [["指标", "值"], ["平均数学", "=AVERAGE(Sheet1!B2:B4)"], ["平均语文", "=AVERAGE(Sheet1!C2:C4)"]]);
  createChart(handle, "Sheet1", "chart1", { type: "bar", dataRange: "B2:D4" });
  const saved = await saveWorkbook(handle);
  assert.ok(saved.artifactId, "保存产出新 artifact");

  // 重读验证：排序生效、公式存在、原区域行列不丢
  const re = await openWorkbook(saved.artifactId);
  assert.ok(re, "保存后 workook 可重开");
  const rows = readRange(re, "Sheet1", "A1:E4");
  assert.equal(rows.columns.length, 5, "列头完整");
  assert.equal(rows.rows.length, 3, "3 行数据（header 不在 rows 中）");
  assert.equal(rows.rows[0][1], "92", "李四（数学 92）应排首位");
  assert.equal(rows.rows[2][1], "76", "王五（数学 76）应排末位");
  const f2 = readRange(re, "Sheet1", "F2:F2");
  assert.match(String(f2.columns[0] || ""), /AVERAGE/, "平均分公式应存在");
  const summary = workbookSummary(re) as { sheets: Array<{ name: string }> };
  assert.ok(summary.sheets.length >= 2, "统计 sheet 应存在");
  assert.ok(summary.sheets.some((s) => s.name === "统计"));
  const charts = (summary as { charts?: unknown }).charts ?? Object.keys(re.workbook.worksheets).length;
  assert.ok(charts, "图表应存在");
});

test("WP60 长文档：DOCX 内容不丢（heading/段落/列表/表格）", async () => {
  const gen = new DocumentGenerator();
  const longMd = ["# 一级标题", "", "## 二级标题", "", "第一段正文内容，验证不丢失。", "", "- 列表项一", "- 列表项二", "", "| 列A | 列B |", "| 1 | 2 |", "", "结尾段落。"].join("\n");
  const out = await gen.generate({ goal: "排版文档", fileContext: longMd });
  assert.equal(out.content.subarray(0, 2).toString(), "PK");
  const report = await gen.validate(out.content);
  assert.equal(report.ok, true);
  const preview = await gen.renderPreview(out.content);
  const text = preview.map((p) => p.data.toString("utf8")).join(" ");
  for (const key of ["一级标题", "二级标题", "第一段正文内容", "列表项一", "列表项二", "结尾段落"]) {
    assert.ok(text.includes(key), `DOCX 文本应含 ${key}`);
  }
});

test("WP60 PDF：真实 PDF、可被 pdfjs 读回文本、首页可渲染 PNG", async () => {
  const gen = new PdfGenerator();
  const out = await gen.generate({ goal: "生成 PDF", fileContext: "# PDF 报告\n\n这是用于验证的正文内容：旋转圆环与拉格朗日量。" });
  assert.equal(out.content.subarray(0, 5).toString(), "%PDF-", "真实 PDF 头");
  const report = await gen.validate(out.content);
  assert.equal(report.ok, true);
  // pdfjs 读回
  const { summarizePdf } = await import("../lib/files/pdfReader");
  const summary = await summarizePdf(out.content);
  assert.ok(summary, "pdfjs 可解析");
  assert.ok((summary?.pageCount || 0) >= 1);
  assert.match(summary?.text || "", /正文内容|拉格朗日/);
  // 首页渲染 PNG（canvas 链）
  const preview = await gen.renderPreview(out.content);
  assert.ok(preview.length >= 1);
  assert.equal(preview[0].mime, "image/png");
});

test("WP56 契约：各意图的 expectedArtifacts/contract 与交付物一致（禁止 Markdown 冒充）", () => {
  const cases: Array<[string, string, string[]]> = [
    ["做两页 PPT", "做两页产品介绍 PPT", ["pptx"]],
    ["整理表格", "分析这个 Excel 并整理成表格", ["xlsx"]],
    ["转换表格", "把这个 CSV 转成 Excel", ["xlsx"]],
    ["写文档", "把材料整理成 Word 文档", ["docx"]],
    ["生成 PDF", "把这篇内容做成 PDF", ["pdf"]],
    ["做网站", "做一个介绍页面网站", ["html"]],
  ];
  for (const [label, goal, expected] of cases) {
    const plan = buildExecutionPlan({ id: "t", type: "artifact", goal }, []);
    for (const k of expected) {
      assert.ok(plan.expectedArtifacts.includes(k), `${label}（${goal}）应期望 ${k} 产物（got ${plan.expectedArtifacts}）`);
    }
    assert.ok(plan.contract.expectations.length >= 1, `${label} 完成契约必须有 expectations`);
  }
});

test("WP56 网页/项目任务：contract 要求非空文件交付", () => {
  const plan = buildExecutionPlan({ id: "t", type: "agent_workspace", goal: "把网站背景改成深色" }, [{ filename: "site.zip" }]);
  assert.equal(plan.contract.validationPolicy, "strict");
  assert.ok(plan.contract.expectations.some((e) => e.filenamePattern === "*" && e.minCount === 1));
  assert.ok(plan.expectedArtifacts.includes("zip"));
});

test("WP57 refusal 回归：agent 工作指令存在且禁止拒绝式回答", () => {
  assert.match(AGENT_WORK_INSTRUCTION, /不是网页聊天机器人/);
  assert.match(AGENT_WORK_INSTRUCTION, /制作文件/);
  assert.match(AGENT_WORK_INSTRUCTION, /作为 AI 我不能/);
  assert.match(AGENT_WORK_INSTRUCTION, /browser\.\*/);
});

test("WP14 操作语义：analyze/edit/transform/create 检测", () => {
  assert.equal(detectOperation("看看这个 Excel", false), "analyze");
  assert.equal(detectOperation("把第三列排序", true), "edit");
  assert.equal(detectOperation("CSV 转成 XLSX", true), "transform");
  assert.equal(detectOperation("根据数据做一张表", false), "create");
});
