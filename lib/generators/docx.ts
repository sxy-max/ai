/** DOCX 生成器：markdown 简化解析（标题/段落/列表/引用/表格）→ 真实 .docx。 */

import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import type { ArtifactGenerator, GeneratorOutput } from "./types";

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "table"; rows: string[][] }
  | { kind: "spacer" };

function parseMarkdown(message: string): Block[] {
  const blocks: Block[] = [];
  const lines = message.split("\n");
  let tableBuffer: string[][] | null = null;

  const flushTable = () => {
    if (tableBuffer && tableBuffer.length) {
      blocks.push({ kind: "table", rows: tableBuffer.filter((row) => !row.every((cell) => /^-+$/.test(cell))) });
      tableBuffer = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushTable(); blocks.push({ kind: "spacer" }); continue; }
    const tableMatch = line.match(/^\|.*\|$/);
    if (tableMatch) {
      const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
      (tableBuffer ||= []).push(cells);
      continue;
    }
    flushTable();
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] }); continue; }
    if (/^[-*]\s+/.test(line)) { blocks.push({ kind: "list", text: line.replace(/^[-*]\s+/, "") }); continue; }
    if (/^>\s?/.test(line)) { blocks.push({ kind: "quote", text: line.replace(/^>\s?/, "") }); continue; }
    blocks.push({ kind: "paragraph", text: line.replace(/^(\d+)[.、]\s+/, "") });
  }
  flushTable();
  return blocks;
}

function inlineRuns(text: string): TextRun[] {
  // 基础加粗/行内代码处理（保留原文，去掉标记）
  const cleaned = text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
  return [new TextRun({ text: cleaned, size: 21 })]; // 10.5pt
}

function blockToParagraphs(block: Block): (Paragraph | Table)[] {
  switch (block.kind) {
    case "heading":
      return [new Paragraph({ text: block.text, heading: headingLevel(block.level) })];
    case "paragraph":
      return [new Paragraph({ children: inlineRuns(block.text), spacing: { after: 120 } })];
    case "list":
      return [new Paragraph({ children: inlineRuns(`• ${block.text}`), spacing: { after: 80 } })];
    case "quote":
      return [new Paragraph({ children: inlineRuns(block.text), style: "Quote" })];
    case "table": {
      const rows = block.rows.map(
        (row) => new TableRow({ children: row.map((cell) => new TableCell({ children: [new Paragraph({ text: cell })] })) })
      );
      return [new Table({ rows }), new Paragraph({ spacing: { after: 120 } })];
    }
    case "spacer":
      return [];
  }
}

function headingLevel(level: number) {
  switch (level) {
    case 1: return HeadingLevel.HEADING_1;
    case 2: return HeadingLevel.HEADING_2;
    case 3: return HeadingLevel.HEADING_3;
    default: return HeadingLevel.HEADING_4;
  }
}

export const generateDocx: ArtifactGenerator = async (input) => {
  const blocks = parseMarkdown(input.message);
  const paragraphs = blocks.flatMap(blockToParagraphs);
  if (!paragraphs.length) paragraphs.push(new Paragraph({ text: input.message, spacing: { after: 120 } }));

  const document = new Document({
    styles: { default: { document: { run: { font: "Microsoft YaHei" } } } },
    sections: [{ properties: {}, children: paragraphs }]
  });
  const content = await Packer.toBuffer(document);
  return {
    filename: "文档.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    kind: "docx",
    content: Buffer.from(content)
  };
};
