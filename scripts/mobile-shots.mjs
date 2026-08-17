// Mobile Workbench AFTER 截图（视觉验收证据，§30/§32/§33）
// 用法：先 npm run build，然后 node scripts/mobile-shots.mjs
// （脚本自行拉起 next start -p 3100 E2E_MODE，退出时清理）
// 输出：docs/mobile-acceptance/*.png（375 / 430 / 1280 三档 viewport）
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const BASE = process.env.MOBILE_SHOTS_BASE || "http://127.0.0.1:3100";
const OUT = "docs/mobile-acceptance";
const VIEWPORTS = [
  { name: "narrow-375", width: 375, height: 667, isMobile: true, hasTouch: true },
  { name: "standard-430", width: 430, height: 932, isMobile: true, hasTouch: true },
  { name: "desktop-1280", width: 1280, height: 800, isMobile: false },
];

const HTML_ARTIFACT = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>嘉立创PCB打样-电路板-嵌入式详解</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f6f7f9;color:#1a1d26;line-height:1.7}
.wrap{max-width:720px;margin:0 auto;padding:24px 18px 80px}
h1{font-size:26px} h2{font-size:20px;margin-top:2em}
.card{background:#fff;border:1px solid #e3e6ec;border-radius:14px;padding:18px;margin:14px 0}
.btn{display:inline-block;background:#2f6feb;color:#fff;border-radius:10px;padding:10px 18px;text-decoration:none}
table{border-collapse:collapse;width:100%} th,td{border:1px solid #dde1e8;padding:8px 10px;text-align:left}
.long{height:900px}
</style></head><body>
<div class="wrap">
<h1>嘉立创 PCB 打样：从电路板到嵌入式</h1>
<p>PCB 打样是"先做一个能测试的真实电路板"，嵌入式是"让芯片按程序工作"。两者在同一块板子上交汇。</p>
<div class="card"><h2>PCB 打样流程</h2><ol><li>画原理图（KiCad / 立创EDA）</li><li>导出 Gerber 文件</li><li>上传嘉立创下单</li><li>3-5 天收到样板</li></ol>
<a class="btn" href="#detail">查看下单说明</a></div>
<div class="card"><h2>价格与交期</h2><table><tr><th>尺寸</th><th>层数</th><th>价格</th><th>交期</th></tr>
<tr><td>≤10×10cm</td><td>2层</td><td>¥5 起</td><td>3-5天</td></tr>
<tr><td>≤10×10cm</td><td>4层</td><td>¥25 起</td><td>4-7天</td></tr></table></div>
<div class="long" id="detail"><h2>下单前检查清单</h2><p>1. 孔到板边 ≥ 0.3mm；2. 线宽 ≥ 0.15mm；3. 拼板用 V-cut 或邮票孔；4. 阻焊开窗核对。</p>
<p>嵌入式开发板常用：STM32、ESP32、瑞萨。选型看外设、功耗、工具链生态。</p></div>
</div></body></html>`;

const MD_ARTIFACT = `# 电路板、PCB、PCB 打样与嵌入式的关系

**一句话主线**：电路板是载体，PCB 是它的制造图纸，PCB 打样是"先做一块真板子来验证图纸"，嵌入式是"让板子上的芯片按程序工作"——四者是一条链上的不同环节。

## 先分清容易混淆的三个词

- **电路板（PCBA）**：贴好元器件的成品板。
- **PCB**：还没贴元器件的裸板，是电路板的"骨架"。
- **PCB 打样**：小批量制造 PCB 裸板的动作，属于制造环节。

> 不是"打样 = 做成品电路板"，而是"打样 = 先把裸板做出来，再贴片组装成电路板"。

## 机制：一块板子如何从图纸变成产品

| 环节 | 输入 | 输出 | 关键变量 |
|---|---|---|---|
| 画图 | 原理图 | Gerber 文件 | 线宽/间距/层数 |
| 打样 | Gerber | 裸板 | 尺寸、铜厚、工艺 |
| 贴片 | 裸板+元器件 | PCBA | 焊点良率 |
| 烧程序 | PCBA | 可工作设备 | 固件、bootloader |

**为什么要打样而不是直接量产？** 因为打样能暴露图纸上发现不了的问题：线距太近会短路、铜皮太薄会过热、孔位偏移会导致贴片失败。打样是**低成本试错**——验证"变量 → 结果"的关系后再放大批量。

## 边界

打样省不了设计验证：静电防护、电源完整性、EMC 这类问题，**不是**打样能发现的，需要专门测试。

## 迁移：把这条链想通一次，PCB、电路板、嵌入式就不再是三个孤立术语

看到任何"打样"类概念，先问：**它改变了制造链上哪个变量？** 答案决定了它属于哪个环节，也决定了它的成本与风险。`;

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/api/auth/me", { cache: "no-store", signal: AbortSignal.timeout(5_000) });
      if (r.ok || r.status === 401) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("dev server 未就绪: " + BASE);
}

async function createArtifact(body) {
  const r = await fetch(BASE + "/api/artifacts/create", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const j = await r.json();
  if (!r.ok) throw new Error("artifact create failed: " + JSON.stringify(j));
  return j.id;
}

async function createTask(goal) {
  const form = new FormData();
  form.append("goal", goal);
  const r = await fetch(BASE + "/api/tasks", { method: "POST", headers: authHeaders, body: form, cache: "no-store" });
  const j = await r.json();
  if (!r.ok) throw new Error("task create failed: " + JSON.stringify(j));
  return j.task.id;
}

/** Production screenshots authenticate through the ordinary access route. E2E dev mode returns an empty header. */
async function authenticate() {
  const current = await fetch(BASE + "/api/auth/me", { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  if (current.ok) return { headers: {}, cookie: "" };

  const password = process.env.MOBILE_SHOTS_PASSWORD;
  if (!password) throw new Error("production screenshot requires MOBILE_SHOTS_PASSWORD");
  const login = await fetch(BASE + "/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!login.ok) throw new Error(`screenshot login failed: ${login.status}`);
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) throw new Error("screenshot login returned no session cookie");
  return { headers: { cookie }, cookie };
}

mkdirSync(OUT, { recursive: true });

// 自拉起已构建的 production server（E2E_MODE 仅用于本地 fixture/auth）；退出时清理。
const { NEXT_E2E: _nextE2e, ...productionEnv } = process.env;
const server = process.env.MOBILE_SHOTS_BASE ? null : spawn("npx", ["next", "start", "-p", "3100"], {
  cwd: process.cwd(),
  env: { ...productionEnv, E2E_MODE: "1", NEXT_PUBLIC_E2E_MODE: "1" },
  stdio: "ignore",
  shell: process.platform === "win32",
});
const shutdown = () => { try { server?.kill(); } catch {} };
process.once("SIGINT", () => { shutdown(); process.exit(130); });
process.once("SIGTERM", () => { shutdown(); process.exit(143); });
process.once("exit", shutdown);

await waitReady();
console.log("[mobile-shots] server ready");
const auth = await authenticate();
const authHeaders = auth.headers;

// 造真实数据：HTML artifact + Markdown artifact + 一个任务（首页最近任务区块有内容）
const htmlId = await createArtifact({ filename: "嘉立创PCB打样-电路板-嵌入式详解.html", mime: "text/html", kind: "html", content: HTML_ARTIFACT, source: "shot" });
const mdId = await createArtifact({ filename: "电路板-PCB-打样-嵌入式关系.md", mime: "text/markdown", kind: "markdown", content: MD_ARTIFACT, source: "shot" });
await createTask("帮我调研 PCB 打样流程并做一份说明文档");
console.log(`[mobile-shots] artifacts: html=${htmlId} md=${mdId}`);

const browser = await chromium.launch();
const results = [];
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: 2 });
  if (auth.cookie) {
    const [name, ...value] = auth.cookie.split("=");
    await ctx.addCookies([{ name, value: value.join("="), url: BASE }]);
  }
  const page = await ctx.newPage();
  const shot = (name, fullPage = false) => page.screenshot({ path: `${OUT}/${vp.name}-${name}.png`, fullPage });
  const metrics = {};

  await page.goto(`${BASE}/`);
  await page.waitForSelector(".launcher-form");
  await shot("home");
  metrics.homeOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  metrics.homeComposerY = await page.locator('[aria-label="任务描述"]').boundingBox().then((b) => Math.round(b.y));

  await page.goto(`${BASE}/tasks`);
  await page.waitForSelector(".task-card, .tasks-empty", { timeout: 20000 });
  await shot("tasks");

  await page.goto(`${BASE}/artifacts/${htmlId}/viewer`);
  await page.waitForSelector(".viewer-iframe, .viewer-note", { timeout: 20000 });
  await page.waitForTimeout(1200);
  await shot("html-viewer");
  metrics.htmlFrameArea = await page.evaluate(() => {
    const f = document.querySelector(".viewer-iframe");
    if (!f) return 0;
    const r = f.getBoundingClientRect();
    return Math.round((r.width * r.height) / (window.innerWidth * window.innerHeight) * 100);
  });

  await page.goto(`${BASE}/artifacts/${mdId}/viewer`);
  // 等 Markdown 内容真正渲染（rich 内容出现）；超时则截当前状态便于诊断
  await page.waitForSelector(".viewer-rich .rich-content p, .viewer-note:not(:has-text('加载中'))", { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(500);
  await shot("md-viewer");

  await page.goto(`${BASE}/chat`);
  await page.waitForSelector(".chat-panel", { timeout: 20000 });
  await shot("chat");

  await ctx.close();
  results.push({ vp: vp.name, metrics });
}

await browser.close();
writeFileSync(`${OUT}/metrics.json`, JSON.stringify(results, null, 2));
console.log("[mobile-shots] done →", OUT);
console.log(JSON.stringify(results, null, 2));
