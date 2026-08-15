/** Generator 边界 / XLSX Reader / Document Adapter / PPTX theme 测试（V1.2 WP14-17）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundaryFor, shouldUseAgent } from "../../lib/generators/boundary";
import { summarizeXlsx, xlsxSummaryText } from "../../lib/files/xlsxReader";
import { documentAdapterFor } from "../../lib/files/documentAdapter";
import { renderPptxFromSpec } from "../../lib/generators/pptxRenderer";
import * as XLSX from "xlsx";

/* ---------- WP14 Generator 边界 ---------- */

test("HTML：简单包装 deterministic；按图/项目必须 Agent", () => {
  assert.equal(boundaryFor("html")?.deterministic, true);
  assert.equal(shouldUseAgent("html", "把这段文字包成 HTML"), false);
  assert.equal(shouldUseAgent("html", "按截图重做页面"), true);
  assert.equal(shouldUseAgent("html", "修改 zip 项目里的 index.html"), true);
});

test("CSV：明确转换 deterministic；语义/按图 → Agent", () => {
  assert.equal(shouldUseAgent("csv", "删除重复行并按第二列排序"), false);
  assert.equal(shouldUseAgent("csv", "按截图清洗数据"), true);
});

test("PPTX：永远 deterministic（LLM 只做 spec，渲染确定性）", () => {
  assert.equal(boundaryFor("pptx")?.deterministic, true);
  assert.equal(shouldUseAgent("pptx", "做一个 PPT"), false);
  assert.match(boundaryFor("pptx")?.note || "", /PresentationSpec/);
});

/* ---------- WP16 XLSX Reader ---------- */

test("xlsx 摘要：sheets/列/行数/样例", () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["name", "score", "city"],
    ["alice", 30, "北京"],
    ["bob", 10, "上海"],
    ["carol", 20, "深圳"],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "Sales");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const summary = summarizeXlsx(buf);
  assert.ok(summary);
  assert.equal(summary?.sheetCount, 1);
  assert.deepEqual(summary?.sheets[0].columns, ["name", "score", "city"]);
  assert.equal(summary?.sheets[0].rowCount, 3);
  assert.equal(summary?.sheets[0].sampleRows.length, 3);
});

test("xlsx 摘要文本可注入上下文", () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([["a", "b"], ["1", "2"]]);
  XLSX.utils.book_append_sheet(wb, ws, "S");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const text = xlsxSummaryText(summarizeXlsx(buf)!);
  assert.match(text, /sheet「S」/);
  assert.match(text, /1 行/);
  assert.match(text, /列：a、b/);
});

test("损坏 xlsx（非法 zip）→ null（降级不抛错）", () => {
  // 损坏的 ZIP 头（PK\x03\x04 + 垃圾）——SheetJS 无法按任何格式解析
  const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("garbage-not-a-valid-zip-archive", "utf8")]);
  assert.equal(summarizeXlsx(broken), null);
});

/* ---------- WP17 Document Adapter ---------- */

test("MD adapter：读标题/标题数 + 往返", () => {
  const adapter = documentAdapterFor("note.md");
  assert.ok(adapter);
  const ctx = adapter!.read(Buffer.from("# 标题\n\n正文段落\n\n## 小节\n\n内容", "utf8"), "note.md");
  assert.ok(ctx);
  assert.equal(ctx?.metadata.title, "标题");
  assert.equal(ctx?.metadata.headings, "2");
  const roundtrip = adapter!.write(ctx!.content, "note.md");
  assert.equal(roundtrip.toString("utf8"), ctx?.content);
});

test("TXT/HTML adapter + 未知格式返回 null", () => {
  const txt = documentAdapterFor("data.txt");
  assert.equal(txt?.read(Buffer.from("a\nb"), "data.txt")?.metadata.lines, "2");
  const html = documentAdapterFor("page.html");
  assert.equal(html?.read(Buffer.from("<html><title>我的页面</title></html>"), "page.html")?.metadata.title, "我的页面");
  assert.equal(documentAdapterFor("archive.zip"), null);
  assert.equal(documentAdapterFor("doc.docx"), null, "DOCX 下一阶段（方案已记录）");
});

/* ---------- WP15 PPTX theme ---------- */

test("pptx theme：spec.theme 覆盖默认配色（产物仍为合法 PPTX）", async () => {
  const spec = {
    title: "主题测试",
    slides: [{ title: "页", sections: ["要点一", "要点二"], equations: [], layout: "content" as const }],
    theme: { accent: "FF0000", titleBackground: "111111", bodyText: "333333" },
  };
  const buf = await renderPptxFromSpec(spec);
  assert.ok(buf.length > 1000, "应产出真实 pptx buffer");
  // ZIP 容器合法
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  assert.ok(zip.file("[Content_Types].xml"), "Content_Types 存在");
  assert.ok(zip.file("ppt/presentation.xml"), "presentation.xml 存在");
  const slideCount = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
  assert.equal(slideCount, 2, "标题页 + 1 内容页");
});

test("无 theme 时默认配色渲染不回归", async () => {
  const buf = await renderPptxFromSpec({ title: "默认", slides: [{ title: "页", sections: ["x"], equations: [] }] });
  assert.ok(buf.length > 1000);
});
