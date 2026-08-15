/**
 * 产物截图渲染器（V1.2 WP12）：HTML 产物 → PNG（playwright chromium）。
 * 供 VisionVerifier 使用：渲染任务产物页面，再经 MiniMax describe 得到产物侧
 * VisionContext，与参考图 VisionContext 结构化比较。
 * 纯本地/服务器 Node 环境；无浏览器时返回 null（验证跳过，不影响任务）。
 */

import fs from "node:fs";
import path from "node:path";

export type RenderOptions = {
  viewport?: { width: number; height: number };
  timeoutMs?: number;
};

/** 渲染 HTML 文件为 PNG；失败返回 null（调用方降级跳过视觉验证）。 */
export async function renderHtmlToPng(htmlPath: string, outPath: string, options: RenderOptions = {}): Promise<string | null> {
  if (!fs.existsSync(htmlPath)) return null;
  const viewport = options.viewport || { width: 900, height: 620 };
  try {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport });
      await page.setContent(fs.readFileSync(htmlPath, "utf8"), { waitUntil: "networkidle", timeout: options.timeoutMs || 20_000 });
      await page.screenshot({ path: outPath, fullPage: true });
      return outPath;
    } finally {
      await browser.close();
    }
  } catch {
    return null;
  }
}

/** 渲染并转 dataUrl（供 describeImageBase64 直接使用）。 */
export async function renderHtmlToDataUrl(htmlPath: string, options?: RenderOptions): Promise<string | null> {
  const outPath = path.join(path.dirname(htmlPath), `.verify-${Date.now()}.png`);
  const rendered = await renderHtmlToPng(htmlPath, outPath, options);
  if (!rendered) return null;
  try {
    const buf = fs.readFileSync(outPath);
    fs.rmSync(outPath, { force: true });
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}
