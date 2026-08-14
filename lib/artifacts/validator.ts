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

/** 验证产物格式；返回 null 表示跳过（未知类型按非空校验）。 */
export async function validateArtifactFormat(
  artifactId: string,
  filename: string,
  kind: string
): Promise<ArtifactValidationResult | null> {
  const buf = artifactService.readContent(artifactId);
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
