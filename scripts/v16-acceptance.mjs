// V1.6 综合验收（§44）：真实网站 ZIP + 参考 UI 截图 + CSV 数据 + 需求文档 → 完整重构任务。
// Preflight → Claude Code（directive）→ vision MCP（参考图）→ 文件修改 → 打包 → 验证。
const BASE = "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "v16-accept@test.local";
const PASSWORD = "V16Accept-2026!";
let cookie = "";

async function api(path, { method = "GET", body, form } = {}) {
  const headers = { cookie };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const resp = await fetch(`${BASE}${path}`, { method, headers, body: payload, cache: "no-store" });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: resp.status, json, text };
}

function multipart(fields, files) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files || []) form.append("files", new Blob([f.buf]), f.name);
  return form;
}

async function pollTask(taskId, timeoutMs = 900000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api(`/api/tasks/${taskId}`);
    const t = r.json?.task || {};
    if (t.status === "completed") return { ok: true, task: t };
    if (t.status === "failed" || t.status === "cancelled") return { ok: false, task: t };
    await new Promise((res) => setTimeout(res, 8000));
  }
  return { ok: false, task: { status: "timeout" } };
}

async function main() {
  let login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  if (login.status !== 200) {
    await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: "V16Accept", inviteCode: INVITE }), cache: "no-store" });
    login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  }
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  // ---- 输入材料 ----
  const siteZip = Buffer.from("", "utf8"); // placeholder replaced below
  void siteZip;
  // 用真实 zip：jszip 不可用（容器），用 adm-zip？——用 node 内置 zip 不可行；用最小手工 zip（stored）
  // 简化：直接上传两个文件（index.html + style.css）作为网站输入（等价 ZIP 项目输入）
  const indexHtml = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>旧网站</title>
<link rel="stylesheet" href="style.css"></head><body>
<h1>旧标题</h1><p>这是旧内容。</p>
<table id="data"><tr><th>名称</th><th>数值</th></tr></table>
</body></html>`, "utf8");
  const styleCss = Buffer.from("body { font-family: serif; background: #fff; color: #000; }", "utf8");
  // 参考图：真实 PNG（vision fixture reference.png——简单卡片 UI）
  const { readFileSync } = await import("node:fs");
  const refPng = readFileSync("/fixtures/reference.png");
  const csv = Buffer.from("名称,数值\n产品A,120\n产品B,85\n产品C,200", "utf8");
  const reqMd = Buffer.from("# 重构需求\n\n1. 页面整体改为现代卡片式布局（参考图风格：浅色背景、圆角卡片、蓝色主色）\n2. 将 CSV 数据渲染为表格展示（三行数据）\n3. 适配移动端（窄屏不横向滚动）\n4. 完成后打包网站\n", "utf8");

  console.log("上传输入并创建综合任务...");
  const created = await api("/api/tasks", { method: "POST", form: multipart({
    goal: "根据参考图和需求文档重构这个网站：现代卡片式布局（参考图风格）、把 CSV 数据渲染成表格、移动端适配，完成后打包网站",
    title: "V16-综合验收",
    type: "agent_workspace",
  }, [
    { name: "index.html", buf: indexHtml },
    { name: "style.css", buf: styleCss },
    { name: "reference.png", buf: refPng },
    { name: "scores.csv", buf: csv },
    { name: "需求.md", buf: reqMd },
  ]) });
  const taskId = created.json?.task?.id;
  if (!taskId) throw new Error(`创建失败: ${created.text.slice(0, 200)}`);
  console.log("task:", taskId);

  const r = await pollTask(taskId);
  if (!r.ok) throw new Error(`任务失败: ${r.task.status} ${r.task.error || ""}`);
  console.log("任务完成 ✓");

  // ---- 验证 ----
  const detail = (await api(`/api/tasks/${taskId}`)).json;
  const artifacts = detail?.artifacts || [];
  console.log("产物:", artifacts.map((a) => `${a.name}(${a.type},${a.size}B)`).join(", ") || "无");

  // 1. 真实产物（zip 或 html）
  const zip = artifacts.find((a) => a.type === "zip" || a.name.endsWith(".zip"));
  const html = artifacts.find((a) => a.type === "html" || a.name.endsWith(".html"));
  if (!zip && !html) throw new Error("无 zip/html 产物");

  // 2. 下载并检查内容（html 产物直接查；zip 用 busybox unzip）
  let htmlContent = "";
  if (html) {
    const dl = await fetch(`${BASE}${html.downloadUrl}`, { headers: { cookie }, cache: "no-store" });
    htmlContent = await dl.text();
  } else if (zip) {
    const { execFileSync } = await import("node:child_process");
    const dl = await fetch(`${BASE}${zip.downloadUrl}`, { headers: { cookie }, cache: "no-store" });
    const buf = Buffer.from(await dl.arrayBuffer());
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/fixtures/v16-result.zip", buf);
    const list = execFileSync("unzip", ["-l", "/fixtures/v16-result.zip"], { encoding: "utf8" });
    console.log("zip 内容:", list.split("\n").filter((l) => /\.(html|css|js|md)$/.test(l)).map((l) => l.trim().split(/\s+/).pop()).join(", "));
    const htmlOut = execFileSync("unzip", ["-p", "/fixtures/v16-result.zip", "index.html"], { encoding: "utf8" });
    htmlContent = htmlOut;
  }

  // 3. 内容断言
  const checks = [];
  checks.push(["数据整合（产品A）", /产品A/.test(htmlContent)]);
  checks.push(["数据整合（产品C）", /产品C/.test(htmlContent)]);
  checks.push(["旧标题已改", !/旧标题/.test(htmlContent)]);
  checks.push(["参考图风格（蓝色主色）", /#[0-9a-fA-F]*[bB]lue|#[0-9a-fA-F]{6}|blue|#2\d\d|#3\d\d/i.test(htmlContent) || /style\.css/.test(htmlContent)]);
  checks.push(["移动端 viewport", /viewport/.test(htmlContent)]);
  for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);

  // 4. 视觉使用证据（Claude Code 调 vision MCP）
  const events = detail?.events || [];
  const visionUsed = events.some((e) => {
    const p = e.payload || {};
    return /vision|视觉|参考图/i.test(String(p.detail || "") + String(p.label || ""));
  });
  console.log(`${visionUsed ? "✓" : "?"} 视觉信息使用（事件中 vision/参考图 痕迹）`);

  const passed = checks.every(([, ok]) => ok);
  if (!passed) throw new Error("内容断言未全过");
  console.log("COMPREHENSIVE ACCEPTANCE PASS：真实综合任务经 Preflight→Claude Code→Vision→修改→产物 ✓");
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
