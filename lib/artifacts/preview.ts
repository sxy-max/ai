/**
 * PreviewService（V1.4 WP18）：Artifact 预览生成（缓存）。
 * generatePreview(artifact) → { previewType, previewAssets, metadata }
 * 按 family 路由：ppt→slide thumbs（服务器 LibreOffice）/ pdf→page png /
 * docx→text / xlsx→table html / html→原样 / image→原图 / zip→file tree。
 * Preview 作为缓存 Artifact 存储（不重复生成）。
 */

import fs from "node:fs";
import path from "node:path";
import { artifactService } from "./service";
import { familyOfKind, type ArtifactFamily } from "./registry";
import { summarizeXlsx } from "../files/xlsxReader";

export type PreviewResult = {
  previewType: string;
  previewAssets: Array<{ type: string; mime: string; url?: string; content?: string }>;
  metadata: Record<string, unknown>;
  cached: boolean;
};

// 注意：前缀必须通过 sanitizeFilename（[^\w.\-...] → _），冒号会被替换成下划线导致缓存查找失配
const PREVIEW_PREFIX = "preview-";

export class PreviewService {
  /** 生成（或取缓存）预览。 */
  async generatePreview(artifactId: string, kind: string): Promise<PreviewResult> {
    const family = familyOfKind(kind);
    if (!family) {
      return { previewType: "none", previewAssets: [], metadata: {}, cached: false };
    }
    // 缓存：同 artifact 的预览标记存在则复用
    const cached = artifactService.list().find((a) => a.filename === `${PREVIEW_PREFIX}${artifactId}`);
    if (cached) {
      return {
        previewType: family,
        previewAssets: [{ type: family, mime: cached.mimeType, url: `/api/artifacts/${cached.id}` }],
        metadata: { cached: true, sourceArtifact: artifactId },
        cached: true,
      };
    }
    const buf = artifactService.readContent(artifactId);
    if (!buf) return { previewType: "none", previewAssets: [], metadata: {}, cached: false };

    const result = await this.renderPreviewFor(family, artifactId, buf, kind);
    // 缓存：文本类（table/text/tree/html）落盘；image/pdf 的 data URL 内联不落盘（避免大 base64 占存储）
    // 首次返回保留 content 内联（单次往返即可渲染），缓存命中时只返回 url。
    const CACHEABLE_TYPES = ["table", "text", "tree", "html"];
    const cacheable = result.assets.length > 0 && CACHEABLE_TYPES.includes(result.assets[0].type) && !!result.assets[0].content;
    if (cacheable) {
      const previewArtifact = artifactService.createArtifact({
        filename: `${PREVIEW_PREFIX}${artifactId}`,
        content: Buffer.from(result.assets[0].content!),
        kind: "txt",
        mimeType: result.assets[0].mime,
        source: "preview",
        metadata: { sourceArtifact: artifactId, previewType: family },
      });
      result.assets[0].url = `/api/artifacts/${previewArtifact.id}`;
    }
    return { previewType: family, previewAssets: result.assets, metadata: result.metadata, cached: false };
  }

  private async renderPreviewFor(family: ArtifactFamily, artifactId: string, buf: Buffer, kind: string): Promise<{ assets: Array<{ type: string; mime: string; content?: string; url?: string }>; metadata: Record<string, unknown> }> {
    switch (family) {
      case "spreadsheet": {
        const summary = summarizeXlsx(buf);
        if (!summary) return { assets: [], metadata: {} };
        const sheet = summary.sheets[0];
        const rows = sheet.sampleRows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
        const head = sheet.columns.map((c) => `<th>${esc(c)}</th>`).join("");
        return {
          assets: [{ type: "table", mime: "text/html", content: `<table class="preview-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` }],
          metadata: { sheets: summary.sheetCount, rows: sheet.rowCount, columns: sheet.columns.length },
        };
      }
      case "document": {
        // DOCX 文本预览
        try {
          const JSZip = (await import("jszip")).default;
          const zip = await JSZip.loadAsync(buf);
          const xml = await zip.file("word/document.xml")?.async("string");
          const text = xml
            ? xml.replace(/<w:tab[^>]*\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim().slice(0, 10_000)
            : "";
          return { assets: [{ type: "text", mime: "text/plain", content: text }], metadata: { format: "docx" } };
        } catch {
          return { assets: [], metadata: {} };
        }
      }
      case "webpage": {
        return { assets: [{ type: "html", mime: "text/html", content: buf.toString("utf8") }], metadata: { format: "html", sandboxed: true } };
      }
      case "image": {
        // 用真实 mime（kind 只有 "image"，区分 png/jpg 才能正确解码）
        const mime = artifactService.getArtifact(artifactId)?.mimeType || "image/png";
        const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
        return { assets: [{ type: "image", mime: "text/html", content: `<img class="preview-image" src="${dataUrl}" alt="preview" />` }], metadata: { format: "image" } };
      }
      case "text": {
        return { assets: [{ type: "text", mime: "text/plain", content: buf.toString("utf8").slice(0, 200_000) }], metadata: { format: "text" } };
      }
      case "archive": {
        try {
          const JSZip = (await import("jszip")).default;
          const zip = await JSZip.loadAsync(buf);
          const tree = Object.keys(zip.files).sort().slice(0, 200).map((f) => `<li>${esc(f)}${zip.files[f].dir ? "/" : ""}</li>`).join("");
          return { assets: [{ type: "tree", mime: "text/html", content: `<ul class="preview-tree">${tree}</ul>` }], metadata: { files: Object.keys(zip.files).length } };
        } catch {
          return { assets: [], metadata: {} };
        }
      }
      case "pdf": {
        try {
          const { renderPdfFirstPage } = await import("../files/pdfReader");
          const png = await renderPdfFirstPage(buf);
          if (png) {
            return { assets: [{ type: "page", mime: "image/png", content: `data:image/png;base64,${png.toString("base64")}` }], metadata: { format: "pdf" } };
          }
        } catch (e) { console.error("[preview:pdf] render failed:", e); }
        return { assets: [], metadata: {} };
      }
      case "presentation": {
        // slide 缩略图需要 LibreOffice（服务器 work runtime）；本地返回文档结构预览
        try {
          const JSZip = (await import("jszip")).default;
          const zip = await JSZip.loadAsync(buf);
          const slideCount = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
          return { assets: [], metadata: { format: "pptx", slideCount } };
        } catch {
          return { assets: [], metadata: {} };
        }
      }
      default:
        return { assets: [], metadata: {} };
    }
  }
}

function esc(text: string): string {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export const previewService = new PreviewService();

export { PREVIEW_PREFIX };
