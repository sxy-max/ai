/**
 * InputManifest（V1.4 WP46）：任务输入的结构化清单。
 * 每个输入文件 → 类型/大小/结构化摘要（xlsx sheet 结构 / 文本预览 / 二进制标记），
 * 供 Planner（buildPlanContext）与 Agent 上下文使用——Planner 直接获得真实输入结构，
 * 而非只有文件名。
 */

import { artifactService } from "../artifacts/service";

export type InputManifestEntry = {
  filename: string;
  size: number;
  /** 结构化摘要（多行，缩进由调用方处理）。 */
  summary?: string;
};

/** 单个输入文件 → 结构化摘要（文本预览 / xlsx sheet 结构 / 二进制标记）。 */
export async function summarizeInputFile(filename: string, size: number, storageKey: string | null): Promise<string> {
  if (!storageKey) return "";
  let preview = "";
  try {
    const buf = artifactService.readContent(storageKey);
    if (!buf) return "";
    // V1.2 WP16：xlsx 输入给结构化摘要（sheets/列/样例），替代二进制提示
    if (/\.xlsx$/i.test(filename)) {
      const { summarizeXlsx, xlsxSummaryText } = await import("../files/xlsxReader");
      const summary = summarizeXlsx(buf);
      if (summary) {
        preview = `\n  ${xlsxSummaryText(summary).replace(/\n/g, "\n  ")}`;
      } else {
        preview = "（二进制文件，内容不展开预览）";
      }
    } else if (/\.pdf$/i.test(filename)) {
      // V1.4 WP46：PDF 输入给页数+文本预览
      const { summarizePdf } = await import("../files/pdfReader");
      const summary = await summarizePdf(buf);
      if (summary) {
        preview = `\n  PDF ${summary.pageCount} 页${summary.text ? `，正文开头：${summary.text.replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
      } else {
        preview = "（PDF 解析失败，按二进制处理）";
      }
    } else {
      // 二进制守卫：含 NUL 字节按二进制处理，不按 UTF-8 硬读（避免乱码污染上下文）
      const head = buf.subarray(0, 512);
      if (head.includes(0)) {
        preview = "（二进制文件，内容不展开预览）";
      } else {
        preview = buf.subarray(0, 4000).toString("utf8").replace(/\s+/g, " ").slice(0, 1200);
      }
    }
  } catch {}
  return preview;
}

/** 任务输入 → InputManifest 文本（Planner/Agent 上下文统一格式）。 */
export async function buildInputManifest(files: Array<{ filename: string; size: number; storageKey: string | null }>): Promise<InputManifestEntry[]> {
  const entries: InputManifestEntry[] = [];
  for (const file of files) {
    const summary = await summarizeInputFile(file.filename, Number(file.size || 0), file.storageKey);
    entries.push({ filename: file.filename, size: Number(file.size || 0), summary: summary || undefined });
  }
  return entries;
}

/** InputManifest → 纯文本（planner 用）。 */
export function inputManifestText(entries: InputManifestEntry[]): string {
  if (!entries.length) return "";
  return `已上传文件：\n${entries.map((e) => `- ${e.filename}（${e.size} bytes）${e.summary ? e.summary : ""}`).join("\n")}`;
}
