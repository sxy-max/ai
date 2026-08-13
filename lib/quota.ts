/**
 * 客户端自己施加的私有额度（非 OpenCode Go 官方额度）。
 * 服务端强制 + 持久化到 /data（volume 挂载），容器重启不清零。
 * 只在「上游真正接受请求并开始生成响应」后计数。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.QUOTA_DATA_DIR || "/data";
const FILE = path.join(DATA_DIR, "quota.json");

const H5 = 5 * 3600 * 1000;
const D7 = 7 * 24 * 3600 * 1000;

type ModelQuota = { "5h": number[]; "7d": number[] };
type Store = Record<string, ModelQuota>;

let cache: Store | null = null;

async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    cache = JSON.parse(raw);
  } catch {
    cache = {};
  }
  return cache!;
}

async function save(store: Store): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {}
  try {
    const tmp = FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(store));
    await fs.rename(tmp, FILE);
  } catch {}
}

export type QuotaLimit = { limit5h: number; limit7d: number };

export function quotaConfig(model: string): QuotaLimit | null {
  if (model === "grok-4.5" || model === "qwen3.8-max") {
    return { limit5h: 5, limit7d: 20 };
  }
  return null;
}

export type QuotaStatus = {
  ok: boolean;
  window: "5h" | "7d" | "";
  used: number;
  limit: number;
  retryAfterSeconds: number;
  used7d: number;
  limit7d: number;
};

export async function quotaCheck(model: string): Promise<QuotaStatus> {
  const cfg = quotaConfig(model);
  if (!cfg) {
    return { ok: true, window: "", used: 0, limit: 0, retryAfterSeconds: 0, used7d: 0, limit7d: 0 };
  }
  const store = await load();
  const q = store[model] || { "5h": [], "7d": [] };
  const now = Date.now();
  const in5h = q["5h"].filter((t) => now - t < H5);
  const in7d = q["7d"].filter((t) => now - t < D7);
  if (in5h.length >= cfg.limit5h) {
    const oldest = Math.min(...in5h);
    return {
      ok: false, window: "5h", used: in5h.length, limit: cfg.limit5h,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + H5 - now) / 1000)),
      used7d: in7d.length, limit7d: cfg.limit7d,
    };
  }
  if (in7d.length >= cfg.limit7d) {
    const oldest = Math.min(...in7d);
    return {
      ok: false, window: "7d", used: in7d.length, limit: cfg.limit7d,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + D7 - now) / 1000)),
      used7d: in7d.length, limit7d: cfg.limit7d,
    };
  }
  return { ok: true, window: "", used: in5h.length, limit: cfg.limit5h, retryAfterSeconds: 0, used7d: in7d.length, limit7d: cfg.limit7d };
}

export async function quotaRecordSuccess(model: string): Promise<void> {
  const cfg = quotaConfig(model);
  if (!cfg) return;
  const store = await load();
  const q = store[model] || { "5h": [], "7d": [] };
  const now = Date.now();
  q["5h"].push(now);
  q["7d"].push(now);
  q["5h"] = q["5h"].filter((t) => now - t < H5);
  q["7d"] = q["7d"].filter((t) => now - t < D7);
  store[model] = q;
  cache = store;
  await save(store);
}
