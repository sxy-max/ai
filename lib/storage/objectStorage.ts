/**
 * ObjectStorageAdapter（V1.1 WP18）：对象存储抽象。
 * 第一实现：LocalObjectStorage（磁盘目录）；预留 S3ObjectStorage（接口签名，不强制配置）。
 * Artifact Service 不再直接依赖宿主磁盘路径——经本适配器 put/get/delete/exists。
 */

import fs from "node:fs";
import path from "node:path";

export interface ObjectStorageAdapter {
  put(key: string, content: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** 下载流（可选能力；本地实现返回读流）。 */
  getReadStream?(key: string): NodeJS.ReadableStream | null;
  /** 同步能力（本地实现；远程存储可抛"仅异步"——调用方应优先 await 版）。 */
  putSync?(key: string, content: Buffer): void;
  getSync?(key: string): Buffer | null;
}

export class LocalObjectStorage implements ObjectStorageAdapter {
  constructor(private readonly root: string) {}

  private safeKey(key: string): string {
    const clean = String(key || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
    if (!clean) throw new Error("INVALID_STORAGE_KEY");
    const base = path.resolve(this.root);
    const target = path.resolve(this.root, clean);
    if (target !== base && !target.startsWith(base + path.sep)) {
      throw new Error("STORAGE_KEY_ESCAPE");
    }
    return clean;
  }

  private filePath(key: string): string {
    return path.join(this.root, this.safeKey(key));
  }

  async put(key: string, content: Buffer): Promise<void> {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.filePath(key), content);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return fs.readFileSync(this.filePath(key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      fs.rmSync(this.filePath(key), { force: true });
    } catch {}
  }

  async exists(key: string): Promise<boolean> {
    return fs.existsSync(this.filePath(key));
  }

  getReadStream(key: string): NodeJS.ReadableStream | null {
    try {
      return fs.createReadStream(this.filePath(key));
    } catch {
      return null;
    }
  }

  putSync(key: string, content: Buffer): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.filePath(key), content);
  }

  getSync(key: string): Buffer | null {
    try {
      return fs.readFileSync(this.filePath(key));
    } catch {
      return null;
    }
  }
}

/** S3 兼容预留（腾讯 COS / MinIO / S3 可在此实现；本轮不强制）。 */
export class S3ObjectStorage implements ObjectStorageAdapter {
  constructor(_options: { endpoint?: string; bucket: string; accessKeyId?: string; secretAccessKey?: string }) {
    throw new Error("S3ObjectStorage 未实现（V1.2 候选）：配置腾讯 COS/MinIO/S3 后接入");
  }
  async put(): Promise<void> { throw new Error("S3 未实现"); }
  async get(): Promise<Buffer | null> { throw new Error("S3 未实现"); }
  async delete(): Promise<void> { throw new Error("S3 未实现"); }
  async exists(): Promise<boolean> { throw new Error("S3 未实现"); }
}

/** 当前存储实例（磁盘实现；Artifact Service 经此访问，未来换 S3 不触碰业务）。 */
export const objectStorage: ObjectStorageAdapter = new LocalObjectStorage(
  process.env.ARTIFACTS_ROOT || "/data/artifacts"
);
