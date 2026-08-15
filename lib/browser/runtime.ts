/**
 * Browser Runtime（V1.4 WP19）：Agent 的真实网页能力（Playwright Chromium）。
 * BrowserSession = 单会话单页（可下载）；BrowserRuntime 管理会话与崩溃恢复
 * （任务中浏览器被杀 → 重新 launch → 重新 navigate 继续）。
 * 运行于 worker 进程（host 侧）；Sandbox --network none 内不启用。
 */

import fs from "node:fs";
import path from "node:path";
import { validateBrowserUrl, resolveSecurityPolicy, sanitizeDownloadName, withinDownloadLimit, NavigationBudget, type BrowserSecurityPolicy } from "./security";
import { EXTRACT_SCRIPT, buildObservation, type BrowserObservation, type ExtractedDom } from "./observation";

export type BrowserActionInput =
  | { action: "navigate"; url: string; waitFor?: "load" | "networkidle" }
  | { action: "click"; selector: string }
  | { action: "type"; selector: string; text: string; pressEnter?: boolean }
  | { action: "scroll"; direction?: "down" | "up"; amount?: number }
  | { action: "read_page"; withScreenshot?: boolean }
  | { action: "screenshot" }
  | { action: "back" }
  | { action: "download"; url?: string };

export type BrowserSessionConfig = {
  downloadsDir: string;
  headless?: boolean;
  userAgent?: string;
};

export type BrowserLaunchOptions = {
  /** 下载根目录（绝对路径，必须位于 workspace 内）。 */
  downloadsDir: string;
  /** 截图保存目录（绝对路径，默认 downloadsDir 上级的 browser-screenshots）。 */
  screenshotsDir?: string;
  headless?: boolean;
  userAgent?: string;
};

type PlaywrightPage = {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  evaluate<T = unknown>(fn: string): Promise<T>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  type(selector: string, text: string, opts?: { timeout?: number }): Promise<void>;
  press(selector: string, key: string, opts?: { timeout?: number }): Promise<void>;
  mouse: { wheel(dx: number, dy: number): Promise<void> };
  screenshot(opts?: { type?: string; fullPage?: boolean }): Promise<Buffer>;
  url(): string;
  waitForLoadState(state?: string, opts?: { timeout?: number }): Promise<void>;
  goBack(opts?: { timeout?: number }): Promise<unknown>;
  on(event: string, cb: (arg: unknown) => void): void;
  page?: never;
};

type PlaywrightContext = {
  newPage(): Promise<PlaywrightPage>;
  setDefaultTimeout(ms: number): void;
  close(): Promise<void>;
};

type PlaywrightBrowser = {
  newContext(opts: Record<string, unknown>): Promise<PlaywrightContext>;
  close(): Promise<void>;
};

/** 动态获取 chromium（与 PDF 渲染共用 @playwright/test 的浏览器二进制）。 */
async function loadChromium(): Promise<{ launch(opts: { headless: boolean }): Promise<PlaywrightBrowser> }> {
  try {
    const { chromium } = await import("@playwright/test");
    return chromium as unknown as { launch(opts: { headless: boolean }): Promise<PlaywrightBrowser> };
  } catch (e) {
    throw new Error(`BROWSER_UNAVAILABLE：Playwright Chromium 不可用（${(e as Error)?.message || e}）`);
  }
}

export class BrowserSession {
  private browser: PlaywrightBrowser | null = null;
  private context: PlaywrightContext | null = null;
  private page: PlaywrightPage | null = null;
  private readonly policy: BrowserSecurityPolicy;
  private readonly screenshotsDir: string;
  readonly budget: NavigationBudget;
  /** 最近一次真实导航 URL（崩溃恢复时自动重新导航，WP53）。 */
  lastUrl = "";
  private closed = false;

  constructor(private readonly options: BrowserLaunchOptions) {
    this.policy = resolveSecurityPolicy({ downloadsDir: options.downloadsDir, maxNavigations: 30 });
    this.budget = new NavigationBudget(this.policy.maxNavigations);
    this.screenshotsDir = options.screenshotsDir || path.join(path.dirname(options.downloadsDir), "browser-screenshots");
  }

  get isReady(): boolean {
    return this.browser !== null && this.context !== null && this.page !== null && !this.closed;
  }

  get currentUrl(): string {
    return this.page?.url() || "";
  }

  /** 启动浏览器（幂等；失败时抛出可被上层捕获重试）。 */
  async launch(): Promise<void> {
    if (this.isReady) return;
    const chromium = await loadChromium();
    this.browser = await chromium.launch({ headless: this.options.headless ?? true });
    this.context = await this.browser.newContext({
      userAgent: this.options.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 GoAI-Browser/1.4",
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
    });
    this.context.setDefaultTimeout(this.policy.actionTimeoutMs);
    this.page = await this.context.newPage();
    fs.mkdirSync(this.policy.downloadsDir, { recursive: true });
  }

  /** 执行动作（navigation 计入预算；崩溃时抛 BrowserCrashError）。 */
  async act(input: BrowserActionInput): Promise<BrowserObservation> {
    if (!this.isReady) throw new Error("BROWSER_NOT_READY");
    const page = this.page!;
    switch (input.action) {
      case "navigate": {
        const blocked = validateBrowserUrl(input.url);
        if (blocked) throw new Error(`BLOCKED_URL：${blocked}`);
        if (this.budget.exhausted) throw new Error(`NAVIGATION_BUDGET_EXHAUSTED：本次会话最多 ${this.policy.maxNavigations} 次导航`);
        await page.goto(input.url, { waitUntil: input.waitFor === "networkidle" ? "networkidle" : "load", timeout: this.policy.navigateTimeoutMs });
        this.budget.spend();
        this.lastUrl = page.url();
        return this.observe();
      }
      case "click":
        await page.click(input.selector);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        this.lastUrl = page.url();
        return this.observe();
      case "type": {
        await page.click(input.selector);
        await page.type(input.selector, input.text);
        if (input.pressEnter) await page.press(input.selector, "Enter");
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        this.lastUrl = page.url();
        return this.observe();
      }
      case "scroll": {
        const amount = input.amount ?? (input.direction === "up" ? -600 : 600);
        await page.mouse.wheel(0, amount);
        return this.observe();
      }
      case "read_page":
        return this.observe(Boolean(input.withScreenshot));
      case "screenshot": {
        const shot = await page.screenshot({ type: "png" });
        const rel = await this.saveScreenshot(shot);
        return this.observe(rel);
      }
      case "back":
        await page.goBack({ timeout: this.policy.navigateTimeoutMs }).catch(() => {});
        this.lastUrl = page.url();
        return this.observe();
      case "download": {
        // 下载当前页（缺省 URL）到 workspace 下载目录；响应大小上限检查
        const url = input.url || page.url();
        const blocked = validateBrowserUrl(url);
        if (blocked) throw new Error(`BLOCKED_URL：${blocked}`);
        const name = sanitizeDownloadName(url.split(/[\\/]/).pop() || "download");
        const target = path.join(this.policy.downloadsDir, name);
        // 浏览器内 fetch（对普通链接更稳，可带 cookie）；bytes 传回 host 落盘
        const result = await page.evaluate<{ ok: boolean; size: number; error?: string }>(`(async () => {
          const r = await fetch(${JSON.stringify(url)}, { credentials: "include" });
          if (!r.ok) return { ok: false, size: 0, error: "HTTP " + r.status };
          const b = await r.arrayBuffer();
          return { ok: true, size: b.byteLength, bytes: Array.from(new Uint8Array(b)) };
        })()`);
        if (!result.ok) throw new Error(`DOWNLOAD_FAILED：${result.error || "未知错误"}`);
        if (!withinDownloadLimit(result.size, this.policy)) throw new Error(`DOWNLOAD_TOO_LARGE：超过 ${this.policy.maxDownloadBytes} 字节`);
        const { bytes } = result as unknown as { bytes: number[] };
        fs.writeFileSync(target, Buffer.from(bytes));
        return this.observe();
      }
      default:
        throw new Error(`UNKNOWN_ACTION：${(input as { action: string }).action}`);
    }
  }

  private async observe(withScreenshot?: boolean | string): Promise<BrowserObservation> {
    const shotRel = typeof withScreenshot === "string" ? withScreenshot : withScreenshot ? await this.saveScreenshot(await this.page!.screenshot({ type: "png" })) : undefined;
    return this.observeWithPath(shotRel);
  }

  /** 截图存盘（workspace/browser-screenshots/），返回相对路径。 */
  private async saveScreenshot(shot: Buffer): Promise<string> {
    fs.mkdirSync(this.screenshotsDir, { recursive: true });
    const name = `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    fs.writeFileSync(path.join(this.screenshotsDir, name), shot);
    return path.join("browser-screenshots", name).replace(/\\/g, "/");
  }

  private async observeWithPath(screenshotRel?: string): Promise<BrowserObservation> {
    const page = this.page!;
    const extracted = await page.evaluate<ExtractedDom>(EXTRACT_SCRIPT);
    const url = page.url();
    return buildObservation(extracted, url, this.budget.remaining, screenshotRel);
  }

  /** 关闭浏览器（幂等）。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.context?.close();
      await this.browser?.close();
    } catch {}
    this.context = null;
    this.browser = null;
    this.page = null;
  }
}

export class BrowserCrashError extends Error {
  constructor(message = "浏览器进程异常终止") {
    super(message);
    this.name = "BrowserCrashError";
  }
}

/**
 * BrowserRuntime：多任务共享的浏览器管理器 + 崩溃恢复。
 * getSession() 惰性启动；detectCrash 时自动重启（会话导航预算保留在新会话上）。
 */
export class BrowserRuntime {
  private session: BrowserSession | null = null;
  private readonly options: BrowserLaunchOptions;
  /** 崩溃/关闭后仍保留的最近导航（WP53：重启后自动重新导航）。 */
  private lastUrl = "";

  constructor(options: BrowserLaunchOptions) {
    this.options = options;
  }

  /** 获取（或启动）当前会话；崩溃后自动重启并保留预算 + 重新导航（WP53）。 */
  async getSession(): Promise<BrowserSession> {
    if (this.session && this.session.isReady) return this.session;
    // 旧会话已崩溃/未启动：重建
    const previous = this.session;
    const fresh = new BrowserSession(this.options);
    try {
      await fresh.launch();
    } catch (e) {
      await fresh.close();
      throw e;
    }
    // 继承旧会话的导航预算（崩溃不重置计数）并恢复导航
    if (previous) {
      try {
        const used = previous.budget.remaining;
        while (fresh.budget.remaining < used) fresh.budget.spend();
      } catch {}
      this.lastUrl = previous.lastUrl || this.lastUrl;
    }
    if (this.lastUrl && !fresh.budget.exhausted) {
      try {
        const blocked = validateBrowserUrl(this.lastUrl);
        if (!blocked) await fresh.act({ action: "navigate", url: this.lastUrl });
      } catch {}
    }
    this.session = fresh;
    if (previous) void previous.close().catch(() => {});
    return fresh;
  }

  /** 健康探测：page 可评估则正常（探测失败视为崩溃 → 下一轮 getSession 自动重启）。 */
  async isHealthy(): Promise<boolean> {
    const s = this.session;
    if (!s || !s.isReady) return false;
    try {
      await s["page"]!.evaluate("1");
      return true;
    } catch {
      return false;
    }
  }

  /** 显式关闭当前会话（保留 lastUrl 供下次恢复导航）。 */
  async shutdown(): Promise<void> {
    const s = this.session;
    if (s) this.lastUrl = s.lastUrl || this.lastUrl;
    await s?.close().catch(() => {});
    this.session = null;
  }
}
