/** 附件类型映射（任务文件 → PreflightAttachment）。worker 与 executor 共用。 */

import type { PreflightAttachment } from "./rules";

export type FileLike = { filename: string; mime?: string };

export function attachmentsFromFiles(files: FileLike[]): PreflightAttachment[] {
  return files.map((f) => {
    const name = String(f.filename);
    const mime = String(f.mime || "");
    const kind = mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name) ? "image"
      : /\.zip$/i.test(name) ? "archive"
      : /\.(xlsx|csv)$/i.test(name) ? "spreadsheet"
      : /\.(docx|doc)$/i.test(name) ? "document"
      : /\.pdf$/i.test(name) ? "pdf"
      : "file";
    return { kind, mime, name };
  });
}
