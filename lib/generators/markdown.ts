/** Markdown 生成器：确定性文档（标题 + 小节 + 要点列表）。 */

import { filenameSlug, parseDocument } from "./prompt";
import type { GeneratorInput, GeneratorOutput } from "./types";

export async function generateMarkdown({ message }: GeneratorInput): Promise<GeneratorOutput> {
  const { title, sections } = parseDocument(message);
  const lines: string[] = [`# ${title}`, ""];
  for (const section of sections) {
    lines.push(`## ${section.title}`, "");
    if (section.items.length === 0) {
      lines.push("- （待补充）");
    } else {
      for (const item of section.items) lines.push(`- ${item}`);
    }
    lines.push("");
  }
  const content = Buffer.from(lines.join("\n"), "utf8");
  return { filename: `${filenameSlug(title, "document")}.md`, mime: "text/markdown", kind: "markdown", content };
}
