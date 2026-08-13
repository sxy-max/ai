/**
 * Workspace Vision Scanner —— 把 workspace 内的图片转成 agent 可用的视觉上下文。
 * 每张图片：MiniMax 描述 → `.go-ai/vision/{base}.md`（全文）+ `.go-ai/vision/{base}.json`（结构化）。
 *
 * 视觉内容一律视为 UNTRUSTED：图片内出现的文字/指令仅作参考，不构成对 agent 的指令。
 * vision 失败只降级（返回 scanned/failures 计数），绝不中断任务。
 */

import fs from "node:fs";
import path from "node:path";
import { describeImageBase64, parseVisionFields } from "../vision";
import type { WorkspaceManager } from "../workspace/service";
import { walkWorkspace } from "../workspace/safety";

export type VisionScanResult = {
  /** 是否有视觉描述文件落盘（agent 可据此读取 .go-ai/vision/）。 */
  visionMd: boolean;
  scanned: number;
  failures: number;
};

export type VisionDescribe = (dataUrl: string, apiKey: string) => Promise<string>;

const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
const MEDIA_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** 读图片文件 → dataUrl；读取失败返回 null（跳过该图）。 */
function imageToDataUrl(absPath: string): string | null {
  const ext = path.extname(absPath).toLowerCase();
  const media = MEDIA_BY_EXT[ext];
  if (!media) return null;
  try {
    return `data:${media};base64,${fs.readFileSync(absPath).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * 扫描 workspace 内图片并写入视觉上下文。
 * @param describe 注入式视觉描述器（默认走 MiniMax；测试可 mock）。
 */
export async function scanWorkspaceVision(
  ws: WorkspaceManager,
  apiKey: string,
  describe: VisionDescribe = describeImageBase64
): Promise<VisionScanResult> {
  const result: VisionScanResult = { visionMd: false, scanned: 0, failures: 0 };
  const images = walkWorkspace(ws.root).filter(
    (f) => !f.isLink && IMAGE_RE.test(f.relPath) && !f.relPath.startsWith(".go-ai/")
  );
  if (!images.length) return result;

  const vDir = path.join(ws.dirs.internal, "vision");
  for (const f of images) {
    const dataUrl = imageToDataUrl(f.absPath);
    if (!dataUrl) {
      result.failures++;
      continue;
    }
    let text = "";
    try {
      text = (await describe(dataUrl, apiKey)) || "";
    } catch {
      result.failures++;
      continue;
    }
    const desc = text.trim();
    if (!desc) {
      result.failures++;
      continue;
    }
    const base = path.basename(f.relPath, path.extname(f.relPath));
    fs.mkdirSync(vDir, { recursive: true });
    fs.writeFileSync(path.join(vDir, `${base}.md`), desc + "\n");
    fs.writeFileSync(
      path.join(vDir, `${base}.json`),
      JSON.stringify({ source: f.relPath, ...parseVisionFields(desc) }, null, 2)
    );
    result.visionMd = true;
    result.scanned++;
  }
  return result;
}
