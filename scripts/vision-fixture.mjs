// V11 视觉验收 fixture 生成器（vision MCP 配合使用）
//
// 生成 T3 风格（参考图 → 页面实现）的对比素材：
//   reference.png   —— 参考设计（目标效果）
//   result-ok.png   —— 与参考一致的实现（正例：应判定为"一致"）
//   result-bad.png  —— 偏离参考的实现（反例：配色/布局错误，应判定为"不一致"）
//
// 用法：
//   node scripts/vision-fixture.mjs [输出目录，默认 scripts/fixtures/vision]
//
// 之后用 vision MCP 做验收（docs/V11_VISION_VERIFICATION.md）：
//   vision_compare(reference.png, result-ok.png,  "页面是否按参考图重做且视觉一致")
//   vision_compare(reference.png, result-bad.png, "页面是否按参考图重做且视觉一致")
//
// 不依赖任何模型 key：纯本地 playwright chromium 渲染。

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve(process.argv[2] || path.join(process.cwd(), "scripts", "fixtures", "vision"));

const BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0b0f1a; color: #e8ecf4; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { width: 720px; background: linear-gradient(135deg, #1b2340 0%, #141a30 100%); border: 1px solid #2a3456; border-radius: 16px; padding: 40px; box-shadow: 0 18px 40px rgba(0,0,0,.45); }
  h1 { font-size: 28px; margin-bottom: 8px; letter-spacing: .5px; }
  p.sub { color: #9aa7c7; margin-bottom: 24px; font-size: 15px; }
  .btn { display: inline-block; background: #3b82f6; color: #fff; font-weight: 600; padding: 12px 28px; border-radius: 8px; text-decoration: none; }
  .btn:hover { background: #2563eb; }
  .badge { display: inline-block; background: rgba(59,130,246,.15); color: #93c5fd; border: 1px solid rgba(59,130,246,.35); font-size: 13px; padding: 4px 12px; border-radius: 999px; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 28px; }
  .tile { background: #202a4a; border: 1px solid #2c3a63; border-radius: 10px; padding: 16px; text-align: center; font-size: 13px; color: #b9c4e0; }
  .tile strong { display: block; color: #e8ecf4; font-size: 15px; margin-bottom: 4px; }
`;

// 参考设计：深色卡片 + 蓝色主按钮 + 3 个功能瓷片
const REFERENCE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head>
<body>
  <div class="card">
    <span class="badge">Cloud AI Work System</span>
    <h1>Go AI 云工作台</h1>
    <p class="sub">把文件任务交给云端 Agent，浏览器只负责下达指令与收取结果。</p>
    <a class="btn" href="#">开始使用</a>
    <div class="grid">
      <div class="tile"><strong>文件理解</strong>解析并整理原始输入</div>
      <div class="tile"><strong>Agent 执行</strong>沙盒内多步修改</div>
      <div class="tile"><strong>产物交付</strong>验证后注册可下载</div>
    </div>
  </div>
</body></html>`;

// 正例：忠实复刻参考（仅空白处微差，视觉上应一致）
const OK_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head>
<body>
  <div class="card">
    <span class="badge">Cloud AI Work System</span>
    <h1>Go AI 云工作台</h1>
    <p class="sub">把文件任务交给云端 Agent，浏览器只负责下达指令与收取结果。</p>
    <a class="btn" href="#">开始使用</a>
    <div class="grid">
      <div class="tile"><strong>文件理解</strong>解析并整理原始输入</div>
      <div class="tile"><strong>Agent 执行</strong>沙盒内多步修改</div>
      <div class="tile"><strong>产物交付</strong>验证后注册可下载</div>
    </div>
  </div>
</body></html>`;

// 反例：布局/配色偏离（标题、主色、瓷片缺失）——应判定为"不一致"
const BAD_CSS = BASE_CSS.replace("#3b82f6", "#22c55e").replace("#2563eb", "#15803d")
  .replace("#0b0f1a", "#ffffff").replace("#1b2340", "#f1f5f9").replace("#141a30", "#e2e8f0")
  .replace("color: #e8ecf4;", "color: #1e293b;");
const BAD_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>${BAD_CSS}</style></head>
<body>
  <div class="card">
    <h1>欢迎使用</h1>
    <p class="sub">一个简单介绍页面。</p>
    <a class="btn" href="#">点击进入</a>
    <div class="grid">
      <div class="tile"><strong>功能</strong>第一项</div>
    </div>
  </div>
</body></html>`;

async function render(html, file) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.screenshot({ path: file, fullPage: true });
  } finally {
    await browser.close();
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
await render(REFERENCE_HTML, path.join(OUT_DIR, "reference.png"));
await render(OK_HTML, path.join(OUT_DIR, "result-ok.png"));
await render(BAD_HTML, path.join(OUT_DIR, "result-bad.png"));
console.log(`fixtures written to ${OUT_DIR}`);
