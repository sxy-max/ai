/**
 * 确定性 prompt 解析：从任务描述提取标题/子标题/内容结构，供各生成器复用。
 * 全部为启发式规则（无模型），只做尽力而为的结构化，不保证语义完整。
 */

const LEADING_VERB = /^(请|麻烦|帮我|给我|帮我生成|帮我做|生成|创建|做|弄|搞|来|要|写)(一个|一份|一张|一套|个|份|些)?[\s：:]*/i;
const TRAILING_FORMAT = /[\s，,。；;：:]*(的)?(ppt|pptx|幻灯片|html|网页|index|csv|表格|markdown|\bmd\b)(文件)?[\s，,。；;：:]*$/i;
const LEADING_FORMAT = /^(ppt|pptx|幻灯片|html|网页|csv|表格|markdown|\bmd\b|文档|文件)[\s，,。；;：:]*/i;
const PAGE_HINT = /[\s，,。；;：:]*(\d+\s*页|(一|二|两|三|四|五|六|七|八|九|十)\s*页)[\s，,。；;：:]*/i;
const TOPIC_PREFIX = /^(介绍|关于|讲讲|讲一下|主题是|主题|内容是|做个|来一个|主题：|讲)[\s：:]*/i;

export type Deck = {
  title: string;
  subtitle: string;
  slides: { title: string; bullets: string[] }[];
};

export type DocStructure = {
  title: string;
  sections: { title: string; items: string[] }[];
};

export function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeXml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 去掉引导动词、页数提示、句首/句尾格式词，得到可用的内容主干。 */
export function cleanMessage(message: string): string {
  let m = String(message || "").trim();
  m = m.replace(PAGE_HINT, "").trim();
  for (let i = 0; i < 3 && m; i++) {
    const next = m.replace(LEADING_VERB, "").trim();
    if (next === m) break;
    m = next;
  }
  m = m.replace(LEADING_FORMAT, "").trim();
  m = m.replace(TRAILING_FORMAT, "").trim();
  m = m.replace(TOPIC_PREFIX, "").trim();
  return m;
}

/** 提取主题词（标题）：主干第一句，截断。 */
export function extractTopic(message: string): string {
  const t = cleanMessage(message) || "";
  const first = splitClauses(t)[0] || t;
  if (!first) return "演示文稿";
  return first.length > 18 ? first.slice(0, 18) : first;
}

/** 把文本切成有意义的短句（按换行/句号/分号/逗号/顿号）。 */
export function splitClauses(message: string): string[] {
  return String(message || "")
    .split(/\r?\n/)
    .flatMap((line) => line.split(/[。；;，、]/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 文档结构：标题 + 若干小节（每节 ≤ 4 条，≤ 6 节）。标题用整句，避免切坏标签/转义。 */
export function parseDocument(message: string): DocStructure {
  const title = extractTopic(message);
  const clauses = splitClauses(cleanMessage(message)).filter((c) => c !== title);
  const groups = chunk(clauses, 4).slice(0, 6);
  const sections = groups.length
    ? groups.map((g) => ({ title: g[0], items: g.slice(1) }))
    : [{ title: "要点", items: [] }];
  return { title, sections };
}

/** 幻灯片结构：标题页 + 内容页（每页 ≤ 3 条，总页数 2–6）。 */
export function parseDeck(message: string): Deck {
  const title = extractTopic(message) || "演示文稿";
  const clauses = splitClauses(cleanMessage(message)).filter((c) => c !== title);
  const groups = chunk(clauses, 3).slice(0, 5);
  const slides = groups.length
    ? groups.map((g) => ({ title: g[0], bullets: g.slice(1) }))
    : [{ title: "要点", bullets: [] }];
  return { title, subtitle: "由 Go AI 生成", slides };
}

/** 生成安全文件名主干（保留 CJK/字母数字/中划线），空则回退。 */
export function filenameSlug(title: string, fallback: string): string {
  const slug = String(title || "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}
