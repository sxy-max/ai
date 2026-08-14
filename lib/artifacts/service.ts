import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { computeExpiry, normalizeArtifact, sanitizeFilename } from "./metadata";
import { kindFromFilename, mimeFromKind } from "./mime";
import type { Artifact, ArtifactContent, ClientArtifact, CreateArtifactInput } from "./types";

const MANIFEST_FILE = "manifest.json";

function safeId(id: string): string {
  return String(id || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
}

/** Artifact Service —— 本地磁盘实现（/data/artifacts + manifest.json），统一 create/read/过期/绑定。 */
export class ArtifactService {
  /** root 用 path.resolve 归一化：Windows 下 "/data/artifacts" 需解析为盘符绝对路径，否则路径穿越防护的前缀比较（正/反斜杠）会误伤读操作。 */
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private readonly root: string;

  private manifestPath(): string {
    return path.join(this.root, MANIFEST_FILE);
  }

  private loadManifest(): Record<string, any> {
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath(), "utf8"));
    } catch {
      return {};
    }
  }

  private saveManifest(manifest: Record<string, any>): void {
    try {
      fs.mkdirSync(this.root, { recursive: true });
      fs.writeFileSync(this.manifestPath(), JSON.stringify(manifest));
    } catch {}
  }

  createArtifact(input: CreateArtifactInput): Artifact {
    const filename = sanitizeFilename(input.filename || "file");
    const kind = input.kind || kindFromFilename(filename, input.mimeType);
    const mimeType = input.mimeType || mimeFromKind(kind);
    const id = randomUUID();
    const buf = Buffer.isBuffer(input.content) ? input.content : Buffer.from(String(input.content ?? ""), "utf8");
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(path.join(this.root, id), buf);
    const createdAt = Date.now();
    const artifact: Artifact = {
      id,
      kind,
      filename,
      mimeType,
      size: buf.length,
      status: "ready",
      source: input.source || "manual_upload",
      jobId: input.jobId,
      messageId: input.messageId,
      createdAt,
      expiresAt: computeExpiry(createdAt, input.ttlMs),
      metadata: input.metadata,
    };
    const manifest = this.loadManifest();
    manifest[id] = artifact;
    this.saveManifest(manifest);
    return artifact;
  }

  getArtifact(id: string): Artifact | null {
    const sid = safeId(id);
    if (!sid) return null;
    const raw = this.loadManifest()[sid];
    return raw ? normalizeArtifact(sid, raw) : null;
  }

  readContent(id: string): Buffer | null {
    const sid = safeId(id);
    if (!sid) return null;
    const p = path.join(this.root, sid);
    if (!p.startsWith(this.root + path.sep) || !fs.existsSync(p)) return null;
    try {
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  }

  getArtifactContent(id: string): ArtifactContent | null {
    const artifact = this.getArtifact(id);
    const content = artifact && this.readContent(id);
    if (!artifact || !content) return null;
    return { artifactId: artifact.id, content, storage: "local" };
  }

  list(): Artifact[] {
    return Object.entries(this.loadManifest()).map(([id, raw]) => normalizeArtifact(id, raw));
  }

  listArtifactsForMessage(messageId: string): Artifact[] {
    if (!messageId) return [];
    return this.list().filter((a) => a.messageId === messageId);
  }

  listArtifactsForJob(jobId: string): Artifact[] {
    if (!jobId) return [];
    return this.list().filter((a) => a.jobId === jobId);
  }

  markArtifactExpired(id: string): Artifact | null {
    const sid = safeId(id);
    if (!sid) return null;
    const manifest = this.loadManifest();
    if (!manifest[sid]) return null;
    manifest[sid] = { ...manifest[sid], status: "expired" };
    this.saveManifest(manifest);
    return normalizeArtifact(sid, manifest[sid]);
  }

  deleteArtifact(id: string): boolean {
    const sid = safeId(id);
    if (!sid) return false;
    const manifest = this.loadManifest();
    if (!manifest[sid]) return false;
    delete manifest[sid];
    this.saveManifest(manifest);
    try {
      fs.rmSync(path.join(this.root, sid), { force: true });
    } catch {}
    return true;
  }

  /** 下发给前端的 Artifact 元数据（不含内容），保留旧 name/mime/downloadUrl 字段兼容前端。 */
  serializeArtifactForClient(a: Artifact): ClientArtifact {
    return {
      id: a.id,
      kind: a.kind,
      name: a.filename,
      mime: a.mimeType,
      size: a.size,
      status: a.status,
      downloadUrl: `/api/artifacts/${a.id}`,
    };
  }
}

/** 默认实例：生产落盘目录可通过 ARTIFACTS_ROOT 覆盖（与旧实现一致）。 */
export const artifactService = new ArtifactService(process.env.ARTIFACTS_ROOT || "/data/artifacts");
