// 通用 HTML 渲染截图器（V11 视觉验收配套）
//
// 把任务产物 HTML 渲染为 PNG，供 vision MCP 对比参考图：
//   node scripts/render-html.mjs <input.html> [output.png] [viewportW] [viewportH]
// 默认输出与输入同目录同名 .png；viewport 默认 900x620。
// 纯本地 playwright chromium，无模型依赖。

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const [inputArg, outputArg, wArg, hArg] = process.argv.slice(2);
if (!inputArg) {
  console.error("用法：node scripts/render-html.mjs <input.html> [output.png] [w] [h]");
  process.exit(1);
}
const input = path.resolve(inputArg);
if (!fs.existsSync(input)) {
  console.error(`输入文件不存在：${input}`);
  process.exit(1);
}
const output = path.resolve(outputArg || input.replace(/\.html?$/i, ".png"));
const viewport = { width: Number(wArg) || 900, height: Number(hArg) || 620 };

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport });
  const html = fs.readFileSync(input, "utf8");
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.screenshot({ path: output, fullPage: true });
  console.log(`rendered ${output} (${viewport.width}x${viewport.height})`);
} finally {
  await browser.close();
}
