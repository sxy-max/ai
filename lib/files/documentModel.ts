/**
 * DocumentModel（V1.4 WP13）：统一文档结构。
 * MD/TXT/DOCX/PDF/HTML → Document（sections/headings/paragraphs/tables/images/metadata）。
 * Agent 面对结构化 document，而非五种完全不同的代码路径。
 */

export type DocumentSection = {
  level: number;
  heading: string;
  paragraphs: string[];
  bullets: string[];
};

export type DocumentModel = {
  format: string;
  title: string;
  sections: DocumentSection[];
  headings: string[];
  paragraphs: string[];
  tables: string[][][];
  images: Array<{ index: number; hint: string }>;
  metadata: Record<string, string>;
  wordCount: number;
};

/** MD → DocumentModel（解析 #/##/### + 段落 + 列表 + 表格）。 */
export function markdownToDocument(text: string, filename = "document.md"): DocumentModel {
  const lines = text.split(/\r?\n/);
  const sections: DocumentSection[] = [];
  const paragraphs: string[] = [];
  const tables: string[][][] = [];
  let current: DocumentSection | null = null;
  let inTable: string[][] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inTable?.length) { tables.push(inTable); inTable = null; }
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      current = { level, heading: title, paragraphs: [], bullets: [] };
      sections.push(current);
      continue;
    }
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      if (!inTable) inTable = [];
      const row = trimmed.split("|").slice(1, -1).map((c) => c.trim());
      if (row.some((c) => /^:?-+:?$/.test(c))) continue; // 分隔行
      inTable.push(row);
      continue;
    }
    if (inTable && inTable.length) {
      tables.push(inTable);
      inTable = null;
    }
    const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bullet) {
      (current || { level: 1, heading: "", paragraphs: [], bullets: [] } as DocumentSection).bullets.push(bullet[1]);
      if (!current) sections.push({ level: 1, heading: "", paragraphs: [], bullets: [bullet[1]] });
      continue;
    }
    const paragraph = trimmed;
    paragraphs.push(paragraph);
    if (current) current.paragraphs.push(paragraph);
    else { current = { level: 1, heading: "", paragraphs: [paragraph], bullets: [] }; sections.push(current); }
  }
  if (inTable?.length) tables.push(inTable);

  const title = sections.find((s) => s.level === 1)?.heading || filename.replace(/\.[^.]+$/, "");
  return {
    format: "markdown",
    title,
    sections,
    headings: sections.map((s) => s.heading).filter(Boolean),
    paragraphs,
    tables,
    images: [],
    metadata: { source: filename },
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

/** TXT → DocumentModel（按空行分段）。 */
export function textToDocument(text: string, filename = "document.txt"): DocumentModel {
  const paragraphs = text.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
  return {
    format: "txt",
    title: filename.replace(/\.[^.]+$/, ""),
    sections: [],
    headings: [],
    paragraphs,
    tables: [],
    images: [],
    metadata: { source: filename },
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

/** HTML → DocumentModel（提取标题/段落/列表）。 */
export function htmlToDocument(html: string, filename = "document.html"): DocumentModel {
  const sections: DocumentSection[] = [];
  const paragraphs: string[] = [];
  const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
  const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(html))) {
    const level = Number(m[1]);
    const heading = strip(m[2]);
    sections.push({ level, heading, paragraphs: [], bullets: [] });
  }
  while ((m = pRe.exec(html))) {
    const text = strip(m[1]);
    if (text) paragraphs.push(text);
  }
  const bullets = Array.from(html.matchAll(liRe)).map((x) => strip(x[1])).filter(Boolean);
  if (bullets.length) {
    const last = sections[sections.length - 1] || { level: 2, heading: "", paragraphs: [], bullets: [] };
    last.bullets = bullets;
    if (!sections.includes(last)) sections.push(last);
  }
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || filename.replace(/\.[^.]+$/, "");
  return {
    format: "html",
    title,
    sections,
    headings: sections.map((s) => s.heading).filter(Boolean),
    paragraphs,
    tables: [],
    images: Array.from(html.matchAll(/<img[^>]*src=["']([^"']+)["']/gi)).map((x, i) => ({ index: i, hint: x[1] })),
    metadata: { source: filename },
    wordCount: paragraphs.join(" ").split(/\s+/).filter(Boolean).length,
  };
}

/** 根据文件名选择解析器。 */
export function documentModelFor(format: string, content: Buffer | string, filename: string): DocumentModel {
  const text = typeof content === "string" ? content : content.toString("utf8");
  switch (format) {
    case "markdown": return markdownToDocument(text, filename);
    case "txt": return textToDocument(text, filename);
    case "html": return htmlToDocument(text, filename);
    default: return textToDocument(text, filename);
  }
}

/** DocumentModel → 文本摘要（Agent/Planner 上下文）。 */
export function documentSummary(doc: DocumentModel, maxChars = 2000): string {
  const parts: string[] = [`标题：${doc.title}`];
  for (const section of doc.sections.slice(0, 12)) {
    const head = section.heading ? `## ${section.heading}` : "";
    const body = [...section.paragraphs, ...section.bullets.map((b) => `- ${b}`)].join("\n");
    if (head || body) parts.push([head, body].filter(Boolean).join("\n"));
  }
  if (doc.tables.length) parts.push(`（${doc.tables.length} 个表格）`);
  if (doc.images.length) parts.push(`（${doc.images.length} 张图片）`);
  return parts.join("\n\n").slice(0, maxChars);
}
