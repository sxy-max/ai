/**
 * Browser Observation Model（V1.4 WP21）：Agent 的网页观察。
 * 不把整页 DOM 塞给模型——提炼为 url/title/visibleText/interactiveElements/
 * screenshot/pageState。由浏览器内 evaluate 提取（不依赖 host DOM 解析）。
 */

export type InteractiveElement = {
  tag: string;
  text: string;
  /** a[href] 目标（相对 URL 由 host 侧补全）。 */
  href?: string;
  type?: string;
  name?: string;
  placeholder?: string;
  role?: string;
};

export type BrowserObservation = {
  url: string;
  title: string;
  visibleText: string;
  interactiveElements: InteractiveElement[];
  pageState: {
    readyState: string;
    viewport: { width: number; height: number };
    scrollY: number;
  };
  /** 截图相对路径（workspace 内 browser-screenshots/，如 browser-screenshots/shot-xx.png）。 */
  screenshot?: string;
  navigationCount: number;
};

export const MAX_TEXT_CHARS = 8_000;
export const MAX_ELEMENTS = 120;

/** 浏览器内运行的 DOM 提炼函数（字符串化后 evaluate）。 */
export const EXTRACT_SCRIPT = `(() => {
  const maxText = ${MAX_TEXT_CHARS};
  const maxEl = ${MAX_ELEMENTS};
  const text = (document.body && document.body.innerText || "").replace(/\\s+/g, " ").trim().slice(0, maxText);
  const els = [];
  const selectors = "a[href], button, input, select, textarea, [role=button], [role=link]";
  for (const el of document.querySelectorAll(selectors)) {
    if (els.length >= maxEl) break;
    const tag = el.tagName.toLowerCase();
    const t = (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    if (tag === "a" && !t) continue;
    if (tag === "input" && el.type === "hidden") continue;
    els.push({
      tag,
      text: t,
      href: el.getAttribute("href") || undefined,
      type: el.getAttribute("type") || undefined,
      name: el.getAttribute("name") || undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      role: el.getAttribute("role") || undefined,
    });
  }
  return {
    text,
    els,
    title: document.title || "",
    readyState: document.readyState,
    viewport: { width: innerWidth, height: innerHeight },
    scrollY: Math.round(scrollY || 0),
  };
})()`;

export type ExtractedDom = {
  text: string;
  els: InteractiveElement[];
  title: string;
  readyState: string;
  viewport: { width: number; height: number };
  scrollY: number;
};

/** 相对 href 补全为绝对 URL（host 侧做，浏览器内拿不到 base 时兜底）。 */
export function resolveHref(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/** 组装 Observation（host 侧）。 */
export function buildObservation(extracted: ExtractedDom, url: string, navigationCount: number, screenshot?: string): BrowserObservation {
  return {
    url,
    title: extracted.title,
    visibleText: extracted.text,
    interactiveElements: extracted.els.map((e) => ({ ...e, href: resolveHref(e.href, url) })),
    pageState: { readyState: extracted.readyState, viewport: extracted.viewport, scrollY: extracted.scrollY },
    screenshot,
    navigationCount,
  };
}
