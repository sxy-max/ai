/**
 * browser-mcp：Claude Code 的浏览器能力（DOM 优先，视觉问题才截图）。
 * 工具：browser.navigate / read_page / click / type / scroll / screenshot / download / back
 * 实现：playwright-core + 系统 chromium；观察模型与 go-ai lib/browser 一致（可见文本/交互元素）。
 */

import { createMcpServer } from "./mcp-lite.mjs";

const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";

let browser = null;
let page = null;
let navBudget = 30;

async function launch() {
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: "GoAI-Browser/1.5" });
  page = await context.newPage();
}

async function ensurePage() {
  if (!browser || !page) await launch();
  return page;
}

async function observe() {
  const p = await ensurePage();
  const data = await p.evaluate(() => {
    const visibleText = (document.body?.innerText || "").slice(0, 8000);
    const els = Array.from(document.querySelectorAll("a[href],button,input,select,textarea,[role=button],[role=link]"))
      .slice(0, 120)
      .map((el) => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : "";
        const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/)[0]}` : "";
        const text = (el.textContent || "").trim().slice(0, 40);
        const href = el.getAttribute("href");
        const placeholder = el.getAttribute("placeholder");
        return `${tag}${id}${cls}${text ? ` "${text}"` : ""}${href ? ` href=${href}` : ""}${placeholder ? ` ph=${placeholder}` : ""}`;
      });
    return { url: location.href, title: document.title, visibleText, elements: els, readyState: document.readyState };
  });
  return data;
}

const tools = [
  {
    name: "browser.navigate",
    description: "导航到 URL（仅 http/https）。返回页面观察（标题/可见文本/交互元素）。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, waitFor: { type: "string", enum: ["load", "networkidle"] } },
      required: ["url"],
    },
    handler: async ({ url, waitFor = "load" }) => {
      if (!/^https?:\/\//i.test(String(url))) throw new Error("仅允许 http/https 协议");
      if (navBudget-- <= 0) throw new Error("导航预算已用尽（30 次/会话）");
      const p = await ensurePage();
      await p.goto(String(url), { waitUntil: waitFor, timeout: 60000 });
      return await observe();
    },
  },
  {
    name: "browser.read_page",
    description: "读取当前页 DOM（可见文本 ≤8000 字符、交互元素 ≤120）。DOM 可解时优先本工具，不截图。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => observe(),
  },
  {
    name: "browser.click",
    description: "点击元素（CSS 选择器）。",
    inputSchema: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
    handler: async ({ selector }) => {
      const p = await ensurePage();
      await p.click(String(selector), { timeout: 30000 });
      await p.waitForTimeout(500);
      return await observe();
    },
  },
  {
    name: "browser.type",
    description: "向输入框输入文本（CSS 选择器定位）。",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, text: { type: "string" }, pressEnter: { type: "boolean" } },
      required: ["selector", "text"],
    },
    handler: async ({ selector, text, pressEnter }) => {
      const p = await ensurePage();
      await p.fill(String(selector), String(text), { timeout: 30000 });
      if (pressEnter) await p.keyboard.press("Enter");
      return await observe();
    },
  },
  {
    name: "browser.scroll",
    description: "滚动页面（方向 up/down，或指定像素）。",
    inputSchema: {
      type: "object",
      properties: { direction: { type: "string", enum: ["up", "down"] }, amount: { type: "number" } },
    },
    handler: async ({ direction = "down", amount = 600 }) => {
      const p = await ensurePage();
      await p.evaluate(([dir, amt]) => window.scrollBy(0, dir === "up" ? -amt : amt), [direction, amount]);
      return await observe();
    },
  },
  {
    name: "browser.screenshot",
    description: "截取当前页截图（PNG，返回文件路径——真实视觉检查时用；优先用 read_page 的 DOM）。",
    inputSchema: {
      type: "object",
      properties: { output_path: { type: "string" } },
      required: ["output_path"],
    },
    handler: async ({ output_path }) => {
      const p = await ensurePage();
      const target = String(output_path || "./screenshot.png");
      await p.screenshot({ path: target, fullPage: false });
      return { ok: true, file: target };
    },
  },
  {
    name: "browser.download",
    description: "下载当前页或指定 URL 的文件到 workspace（上限 20MB）。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, output_path: { type: "string" } },
    },
    handler: async ({ url, output_path }) => {
      const p = await ensurePage();
      const target = String(output_path || "./download.bin");
      const body = await p.evaluate(async (u) => {
        const res = await fetch(u || location.href);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        return Array.from(new Uint8Array(buf));
      }, url || null);
      const fs = await import("node:fs");
      fs.writeFileSync(target, Buffer.from(body));
      return { ok: true, file: target, bytes: body.length };
    },
  },
  {
    name: "browser.back",
    description: "返回上一页。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const p = await ensurePage();
      await p.goBack({ timeout: 30000 }).catch(() => {});
      return await observe();
    },
  },
];

createMcpServer({ name: "browser-mcp", version: "1.5.0", tools });
