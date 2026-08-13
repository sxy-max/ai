/** HTML 生成器：确定性、自包含、全部用户文本经转义（防注入）。 */

import { escapeHtml, filenameSlug, parseDocument } from "./prompt";
import type { GeneratorInput, GeneratorOutput } from "./types";

const CSS = `
:root{--bg:#f7f9fc;--card:#ffffff;--ink:#1f2937;--muted:#6b7280;--accent:#2563eb;--line:#e5e7eb}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink);line-height:1.7}
.wrap{max-width:820px;margin:0 auto;padding:40px 20px 64px}
header{margin-bottom:32px}
h1{font-size:30px;letter-spacing:.5px;border-left:4px solid var(--accent);padding-left:14px}
.sub{color:var(--muted);margin-top:8px;font-size:14px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-bottom:20px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
h2{font-size:18px;color:var(--accent);margin-bottom:12px}
ul{list-style:none}
li{position:relative;padding-left:20px;margin-bottom:8px}
li::before{content:"•";position:absolute;left:2px;color:var(--accent)}
footer{color:var(--muted);font-size:13px;text-align:center;margin-top:40px}
@media(prefers-color-scheme:dark){:root{--bg:#0f172a;--card:#1e293b;--ink:#e2e8f0;--muted:#94a3b8;--accent:#60a5fa;--line:#334155}}
`.trim();

export async function generateHtml({ message }: GeneratorInput): Promise<GeneratorOutput> {
  const { title, sections } = parseDocument(message);
  const body = sections
    .map(
      (s) =>
        `<section><h2>${escapeHtml(s.title)}</h2><ul>${s.items
          .map((item) => `<li>${escapeHtml(item)}</li>`)
          .join("")}</ul></section>`
    )
    .join("");
  const html = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${CSS}</style>`,
    "</head>",
    "<body>",
    '<div class="wrap">',
    "<header>",
    `<h1>${escapeHtml(title)}</h1>`,
    '<div class="sub">由 Go AI 生成</div>',
    "</header>",
    `<main>${body}</main>`,
    "<footer>由 Go AI 生成</footer>",
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
  const buf = Buffer.from(html, "utf8");
  return { filename: `${filenameSlug(title, "index")}.html`, mime: "text/html", kind: "html", content: buf };
}
