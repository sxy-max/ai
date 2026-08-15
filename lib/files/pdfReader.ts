/**
 * PDF Reader（V1.4 WP12）：PDF 输入 → 结构化理解。
 * text / pages / metadata 提取；必要页可转 PNG 走 vision。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

type PdfDocLike = {
  numPages: number;
  getPage: (n: number) => Promise<{
    getTextContent: () => Promise<{ items: Array<{ str?: string }> } | null>;
    getOperatorList: () => Promise<{ fnArray: number[] } | null>;
    cleanup: () => void;
    getViewport: (o: { scale: number }) => { width: number; height: number };
    render: (o: unknown) => { promise: Promise<unknown> };
  }>;
  getMetadata: () => Promise<{ info?: Record<string, unknown> } | null>;
  destroy: () => Promise<void>;
};

export type PdfSummary = {
  pageCount: number;
  text: string;
  pages: Array<{ page: number; text: string; chars: number }>;
  metadata: Record<string, string>;
  hasImages: boolean;
};

/** 提取 PDF 文本/页数/元数据（pdfjs-dist；全异步 worker）。 */
export async function summarizePdf(buf: Buffer, maxPages = 50): Promise<PdfSummary | null> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // Node 环境：加载 worker（fallback：禁用 worker 用主线程）
    const task = await (pdfjs.getDocument as unknown as (p: unknown) => Promise<{ promise: Promise<PdfDocLike> }>)({ data: new Uint8Array(buf), disableWorker: true });
    const doc = await task.promise;
    const meta = await doc.getMetadata().catch(() => null);
    const pageCount = Math.min(doc.numPages, maxPages);
    const pages: PdfSummary["pages"] = [];
    let fullText = "";
    let hasImages = false;
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent().catch(() => null);
      const text = content ? content.items.map((item: { str?: string }) => item.str || "").join(" ") : "";
      // 图片检测：operator 列表含 paintImageXObject
      const ops = await page.getOperatorList().catch(() => null);
      if (ops?.fnArray.some((fn: number) => fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject)) {
        hasImages = true;
      }
      pages.push({ page: i, text: text.trim(), chars: text.length });
      fullText += `${text.trim()}\n`;
      page.cleanup();
    }
    await doc.destroy();
    return {
      pageCount: doc.numPages,
      text: fullText.trim().slice(0, 200_000),
      pages,
      metadata: Object.fromEntries(
        Object.entries(meta?.info || {}).filter(([k]) => /title|author|subject|creationdate|producer/i.test(k)).map(([k, v]) => [k, String(v)])
      ),
      hasImages,
    };
  } catch {
    return null;
  }
}

/** 渲染 PDF 首页为 PNG（pdfjs canvas；预览用）。 */
export async function renderPdfFirstPage(buf: Buffer): Promise<Buffer | null> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = await (pdfjs.getDocument as unknown as (p: unknown) => Promise<{ promise: Promise<PdfDocLike> }>)({ data: new Uint8Array(buf), disableWorker: true });
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1.2 });
    // Node 无 DOM canvas：用 @napi-rs/canvas（已依赖 @napi-rs/canvas）
    const { createCanvas } = await import("@napi-rs/canvas");
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context as never, viewport } as never).promise;
    const png = canvas.toBuffer("image/png");
    page.cleanup();
    await doc.destroy();
    return png;
  } catch (e) {
    console.error("[pdfReader:renderPdfFirstPage]", (e as Error)?.message || e);
    return null;
  }
}
export async function writePdfTemp(buf: Buffer): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goai-pdf-"));
  const file = path.join(dir, "input.pdf");
  fs.writeFileSync(file, buf);
  return file;
}
