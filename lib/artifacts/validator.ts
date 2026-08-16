/**
 * Artifact Validator（V1.1 WP12）：产物不是"文件存在"就合格——按格式验证。
 * 接入 TaskCompletionContract 的 formatValidator 注入点；验证失败进入 repair loop。
 */

import path from "node:path";
import { artifactService } from "./service";
import type { ArtifactValidationResult } from "../tasks/completion";

function fail(artifactId: string, filename: string, kind: string, check: string, detail: string): ArtifactValidationResult {
  return { artifactId, filename, kind, ok: false, checks: { [check]: { ok: false, detail } }, error: detail };
}

function pass(artifactId: string, filename: string, kind: string, checks: Record<string, { ok: boolean; detail?: string }>): ArtifactValidationResult {
  return { artifactId, filename, kind, ok: true, checks };
}

/** 数 PPTX 幻灯片页数（Validation 页数契约用）。返回 null 表示无法解析。 */
export async function countPptxSlides(buf: Buffer): Promise<number | null> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buf);
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    return slides.length || null;
  } catch {
    return null;
  }
}

/** 验证产物格式；返回 null 表示跳过（未知类型按非空校验）。
 *  content 可选：调用方传入时直接用（测试/内存场景）；缺省读 ArtifactService（生产）。 */
export async function validateArtifactFormat(
  artifactId: string,
  filename: string,
  kind: string,
  content?: Buffer
): Promise<ArtifactValidationResult | null> {
  const buf = content ?? artifactService.readContent(artifactId);
  if (!buf) return fail(artifactId, filename, kind, "exists", "产物内容缺失");
  if (buf.length === 0) return fail(artifactId, filename, kind, "nonempty", "产物为空");

  switch (kind) {
    case "html": {
      const text = buf.toString("utf8");
      const hasHtml = /<html|<head|<body|<h[1-6]|<div|<p\b/i.test(text);
      if (!hasHtml) return fail(artifactId, filename, kind, "structure", "HTML 结构不合法（无基础标签）");
      return pass(artifactId, filename, kind, { exists: { ok: true }, nonempty: { ok: true }, structure: { ok: true } });
    }
    case "csv": {
      const text = buf.toString("utf8");
      const rows = text.split(/\r?\n/).filter((l) => l.trim());
      if (!rows.length) return fail(artifactId, filename, kind, "parse", "CSV 无可解析行");
      const colCount = rows[0].split(",").length;
      const inconsistent = rows.filter((r) => r.split(",").length !== colCount).length;
      if (inconsistent > 0) return fail(artifactId, filename, kind, "columns", `列数不一致（${inconsistent} 行）`);
      return pass(artifactId, filename, kind, { exists: { ok: true }, parse: { ok: true }, columns: { ok: true } });
    }
    case "json": {
      try {
        JSON.parse(buf.toString("utf8"));
        return pass(artifactId, filename, kind, { exists: { ok: true }, parse: { ok: true } });
      } catch {
        return fail(artifactId, filename, kind, "parse", "JSON 解析失败");
      }
    }
    case "zip": {
      const JSZip = (await import("jszip")).default;
      try {
        const zip = await JSZip.loadAsync(buf);
        const entries = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
        const hasTraversal = Object.keys(zip.files).some((n) => n.includes("..") || path.posix.isAbsolute(n));
        if (hasTraversal) return fail(artifactId, filename, kind, "traversal", "ZIP 含路径穿越条目");
        if (entries.length === 0) return fail(artifactId, filename, kind, "entries", "ZIP 无有效文件");
        return pass(artifactId, filename, kind, { exists: { ok: true }, parse: { ok: true }, traversal: { ok: true }, entries: { ok: true } });
      } catch {
        return fail(artifactId, filename, kind, "parse", "ZIP 无法解压");
      }
    }
    case "pptx": {
      const JSZip = (await import("jszip")).default;
      try {
        const zip = await JSZip.loadAsync(buf);
        if (!zip.file("[Content_Types].xml")) return fail(artifactId, filename, kind, "container", "PPTX 缺少 [Content_Types].xml");
        if (!zip.file("ppt/presentation.xml")) return fail(artifactId, filename, kind, "presentation", "PPTX 缺少 ppt/presentation.xml");
        const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
        if (slides.length === 0) return fail(artifactId, filename, kind, "slides", "PPTX 无幻灯片");
        return pass(artifactId, filename, kind, { exists: { ok: true }, container: { ok: true }, presentation: { ok: true }, slides: { ok: true } });
      } catch {
        return fail(artifactId, filename, kind, "parse", "PPTX 无法解压");
      }
    }
    case "xlsx": {
      const JSZip = (await import("jszip")).default;
      try {
        const zip = await JSZip.loadAsync(buf);
        if (!zip.file("[Content_Types].xml")) return fail(artifactId, filename, kind, "container", "XLSX 缺少 [Content_Types].xml");
        if (!zip.file("xl/workbook.xml")) return fail(artifactId, filename, kind, "workbook", "XLSX 缺少 xl/workbook.xml");
        const sheets = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
        if (sheets.length === 0) return fail(artifactId, filename, kind, "sheets", "XLSX 无工作表");
        return pass(artifactId, filename, kind, { exists: { ok: true }, container: { ok: true }, workbook: { ok: true }, sheets: { ok: true } });
      } catch {
        return fail(artifactId, filename, kind, "parse", "XLSX 无法解压");
      }
    }
    case "docx": {
      const JSZip = (await import("jszip")).default;
      try {
        const zip = await JSZip.loadAsync(buf);
        if (!zip.file("[Content_Types].xml")) return fail(artifactId, filename, kind, "container", "DOCX 缺少 [Content_Types].xml");
        if (!zip.file("word/document.xml")) return fail(artifactId, filename, kind, "document", "DOCX 缺少 word/document.xml");
        return pass(artifactId, filename, kind, { exists: { ok: true }, container: { ok: true }, document: { ok: true } });
      } catch {
        return fail(artifactId, filename, kind, "parse", "DOCX 无法解压");
      }
    }
    case "pdf": {
      const head = buf.subarray(0, 8).toString("latin1");
      if (!head.startsWith("%PDF-")) return fail(artifactId, filename, kind, "header", "PDF 缺少 %PDF- 文件头");
      const tail = buf.subarray(-64).toString("latin1");
      if (!/\%%EOF/.test(tail)) return fail(artifactId, filename, kind, "eof", "PDF 缺少 %%EOF 结尾");
      return pass(artifactId, filename, kind, { exists: { ok: true }, header: { ok: true }, eof: { ok: true } });
    }
    case "markdown":
    case "txt":
    case "text": {
      // 非空 UTF-8 即合格（内容由生成链保证）
      return pass(artifactId, filename, kind, { exists: { ok: true }, nonempty: { ok: true } });
    }
    default:
      return pass(artifactId, filename, kind, { exists: { ok: true } });
  }
}
