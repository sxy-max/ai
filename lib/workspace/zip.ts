/** ZIP 安全处理 —— 防 zip-slip（路径逃逸）、防 zip bomb（解压体积/数量）、防 symlink entry。 */

import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { assertAllowedFilename, assertNoSymlinkEscape, normalizeRelPath, resolveSafePath, walkWorkspace } from "./safety";
import { DEFAULT_LIMITS, WorkspaceError } from "./types";
import type { WorkspaceLimits } from "./types";

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** 安全解压 zip 到 destRoot。任何逃逸/超限都在落盘前拒绝并抛 WorkspaceError。 */
export async function safeExtractZip(zipBuffer: Buffer, destRoot: string, limits: WorkspaceLimits = DEFAULT_LIMITS): Promise<string[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer, { checkCRC32: true });
  } catch (e) {
    throw new WorkspaceError("zip_entry_rejected", `invalid zip: ${e instanceof Error ? e.message : String(e)}`);
  }

  const entries = Object.values(zip.files).filter((e) => !e.dir);
  if (entries.length > limits.maxFiles) {
    throw new WorkspaceError("too_many_files", `zip has too many entries (${entries.length} > ${limits.maxFiles})`);
  }

  // 第一遍：在内存中解压并校验（zip bomb 防护：任何超限都不落盘）。
  let total = 0;
  const planned: { target: string; relPath: string; buffer: Buffer }[] = [];
  for (const entry of entries) {
    const rel = normalizeRelPath(entry.name);
    if (!rel) continue;
    assertAllowedFilename(rel);

    const mode = entry.unixPermissions;
    if (typeof mode === "number" && (mode & S_IFMT) === S_IFLNK) {
      throw new WorkspaceError("symlink_escape", `zip contains symlink entry: ${entry.name}`);
    }

    const target = resolveSafePath(destRoot, entry.name);
    assertNoSymlinkEscape(destRoot, target);

    let buffer: Buffer;
    try {
      buffer = await entry.async("nodebuffer");
    } catch (e) {
      throw new WorkspaceError("zip_entry_rejected", `cannot decompress entry: ${entry.name}`);
    }
    if (buffer.length > limits.maxFileSize) {
      throw new WorkspaceError("file_too_large", `zip entry too large: ${entry.name} (${buffer.length})`);
    }
    total += buffer.length;
    if (total > limits.maxTotalSize) {
      throw new WorkspaceError("zip_bomb", `zip expands beyond maxTotalSize (${total})`);
    }
    planned.push({ target, relPath: rel, buffer });
  }

  // 第二遍：全部校验通过后落盘。
  const written: string[] = [];
  for (const p of planned) {
    fs.mkdirSync(path.dirname(p.target), { recursive: true });
    fs.writeFileSync(p.target, p.buffer);
    written.push(p.relPath);
  }
  return written;
}

/** 把 srcDir 下文件打包为 zip（排除 .go-ai 内部元数据，可用 excludeInternal 控制）。 */
export async function safePackZip(srcDir: string, opts?: { excludeInternal?: boolean }): Promise<Buffer> {
  const zip = new JSZip();
  const files = walkWorkspace(srcDir).filter((f) => !f.isLink);
  for (const f of files) {
    const rel = f.relPath.replace(/\\/g, "/");
    if (opts?.excludeInternal && (rel === ".go-ai" || rel.startsWith(".go-ai/") || rel === "workspace.json")) continue;
    let content: Buffer;
    try {
      content = fs.readFileSync(f.absPath);
    } catch {
      continue;
    }
    zip.file(rel, content);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
