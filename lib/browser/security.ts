/**
 * Browser Security（V1.4 WP20）：浏览器网络策略。
 * 协议白名单（http/https，file:/javascript:/data: 拒绝）、下载仅进 workspace、
 * 会话导航上限、单操作超时、下载大小上限。与 Sandbox 网络策略一致（--network none
 * 的沙盒内不启用 browser；host 侧 browser 仅授权给 workspace 任务）。
 */

const MAX_NAVIGATIONS_PER_SESSION = 30;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const NAVIGATE_TIMEOUT_MS = 60_000;
const ACTION_TIMEOUT_MS = 30_000;

export type BrowserSecurityConfig = {
  /** 下载根目录（必须位于 workspace 内）。 */
  downloadsDir?: string;
  maxNavigations?: number;
  maxDownloadBytes?: number;
  navigateTimeoutMs?: number;
  actionTimeoutMs?: number;
};

export type BrowserSecurityPolicy = {
  maxNavigations: number;
  maxDownloadBytes: number;
  navigateTimeoutMs: number;
  actionTimeoutMs: number;
  downloadsDir: string;
};

export function resolveSecurityPolicy(config?: BrowserSecurityConfig): BrowserSecurityPolicy {
  return {
    maxNavigations: config?.maxNavigations ?? MAX_NAVIGATIONS_PER_SESSION,
    maxDownloadBytes: config?.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES,
    navigateTimeoutMs: config?.navigateTimeoutMs ?? NAVIGATE_TIMEOUT_MS,
    actionTimeoutMs: config?.actionTimeoutMs ?? ACTION_TIMEOUT_MS,
    downloadsDir: config?.downloadsDir ?? "browser-downloads",
  };
}

/** URL 协议白名单校验。返回 null = 合法；否则返回拒绝原因。 */
export function validateBrowserUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "URL 格式无效";
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === "http:" || protocol === "https:") return null;
  if (protocol === "file:") return "禁止访问本地文件（file:// 被安全策略拒绝）";
  if (protocol === "javascript:") return "禁止执行 javascript: URL";
  if (protocol === "data:") return "禁止直接打开 data: URL";
  return `不支持的协议 ${protocol}`;
}

/** 下载文件名净化（防路径穿越：只保留文件名部分；保留空格/CJK）。 */
export function sanitizeDownloadName(raw: string): string {
  const base = String(raw || "download").split(/[\\/]/).pop() || "download";
  const clean = base.replace(/[^\w.\- 一-鿿]/g, "_").slice(0, 120);
  return clean || "download";
}

/** 下载大小上限校验。 */
export function withinDownloadLimit(size: number, policy: BrowserSecurityPolicy): boolean {
  return size <= policy.maxDownloadBytes;
}

/** 会话导航计数（限额控制：防止 Agent 无限跳页面）。 */
export class NavigationBudget {
  private used = 0;
  constructor(private readonly max: number) {}
  get remaining(): number {
    return this.max - this.used;
  }
  get exhausted(): boolean {
    return this.used >= this.max;
  }
  spend(): void {
    this.used += 1;
  }
  toString(): string {
    return `${this.used}/${this.max}`;
  }
}
