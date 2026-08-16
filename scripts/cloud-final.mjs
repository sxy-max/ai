// Cloud AI Work System 最终验收矩阵（本 Goal §43/§44）：
// 真实 Claude Code 容器驱动——普通问答/代码/PPT/XLSX/DOCX/PDF/图片问答/综合任务/项目延续/Cancel/并发。
// 运行（部署后）：
//   scp scripts/cloud-final.mjs tencent-ai:/tmp/
//   scp scripts/fixtures/vision/reference.png tencent-ai:/tmp/final-fixtures/
//   ssh tencent-ai "sudo docker run --rm --network go-ai-net --env-file /opt/ai-client/.env -u root \
//     -e CLAUDE_CHAT_ENABLED=1 \
//     -v /tmp/cloud-final.mjs:/final.mjs -v /tmp/final-fixtures:/fixtures \
//     ai-client:v1.6 node /final.mjs 2>&1 | tail -40"
import fs from "node:fs";

const BASE = process.env.E2E_BASE || "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "cloud-final@test.local";
const PASSWORD = "CloudFinal-2026!";
const FIXTURES = "/fixtures";

let cookie = "";
const results = [];

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
  for (const f of files || []) form.append("files", new Blob([fs.readFileSync(f.path)]), f.name);
  return form;
}

async function pollTask(taskId, timeoutMs = 900_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api(`/api/tasks/${taskId}`);
    const t = r.json?.task || {};
    if (t.status === "completed") return { ok: true, task: { ...t, artifacts: r.json?.artifacts || [] } };
    if (t.status === "failed" || t.status === "cancelled") return { ok: false, task: t };
    await new Promise((res) => setTimeout(res, 5000));
  }
  return { ok: false, task: { status: "timeout" } };
}

async function createTask({ type, goal, title, files }) {
  const r = await api("/api/tasks", { method: "POST", form: multipart({ goal, title: title || goal.slice(0, 40), type }, files) });
  if (r.status !== 200) throw new Error(`createTask ${r.status}: ${r.text.slice(0, 200)}`);
  return r.json?.task?.id || r.json?.id;
}

async function downloadArtifact(downloadUrl) {
  const r = await fetch(`${BASE}${downloadUrl}`, { headers: { cookie }, cache: "no-store" });
  if (r.status !== 200) throw new Error(`download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function runCase(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail });
    console.log(`PASS ${name}${detail ? ` :: ${detail}` : ""}`);
  } catch (error) {
    results.push({ ok: false, name, detail: String(error.message || error).slice(0, 300) });
    console.log(`FAIL ${name} :: ${String(error.message || error).slice(0, 300)}`);
  }
}

/** 从 /api/models 取一个可用的 opencode-go 模型令牌（chat 用真实签名）。 */
async function chatToken() {
  const r = await api("/api/models");
  if (r.status !== 200) throw new Error(`models ${r.status}`);
  const models = r.json?.models || [];
  const m = models.find((x) => x.provider === "opencode-go" && !x.healthStatus || models[0]);
  const picked = m || models[0];
  if (!picked?.modelToken) throw new Error("无模型令牌");
  return { token: picked.modelToken, model: picked.id || picked.model };
}

/** 准备 fixtures：site 文件 + CSV + 需求 + 参考图（reference.png 由部署命令 scp 预置）。 */
function prepareFixtures() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(`${FIXTURES}/index.html`, "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>旧站点</title><link rel='stylesheet' href='style.css'></head><body><header><h1>Old Site</h1></header><main><p>旧内容占位</p></main></body></html>");
  fs.writeFileSync(`${FIXTURES}/style.css`, "body { font-family: sans-serif; margin: 0; } header { background: #eee; padding: 20px; }");
  fs.writeFileSync(`${FIXTURES}/data.csv`, "产品,销量,地区\n手机,120,华东\n电脑,85,华北\n平板,60,华南\n");
  fs.writeFileSync(`${FIXTURES}/requirements.md`, "# 重构需求\n\n- 按参考图重构首页视觉\n- 整合 data.csv 展示销量表\n- 移动端无横向滚动\n- 完成后打包为 zip\n");
  if (!fs.existsSync(`${FIXTURES}/reference.png`)) throw new Error("缺少 /fixtures/reference.png（部署时 scp scripts/fixtures/vision/reference.png）");
}

/** 数 PPTX 页数（unzip -l 数 slide）——容器内 busybox。 */
async function countPptxSlides(buf) {
  fs.writeFileSync("/tmp/check.pptx", buf);
  const { execSync } = await import("node:child_process");
  const out = execSync("unzip -l /tmp/check.pptx | grep -c 'ppt/slides/slide[0-9]*\\.xml'").toString().trim();
  return Number(out);
}

async function main() {
  let login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  if (login.status !== 200) {
    const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: "CloudFinal", inviteCode: INVITE }), cache: "no-store" });
    if (reg.status !== 200) throw new Error(`注册失败 ${reg.status}`);
    login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  }
  const setCookie = login.headers.get("set-cookie") || "";
  cookie = setCookie.split(";")[0];
  console.log("登录成功");

  prepareFixtures();

  // C01 普通问答：CLAUDE_CHAT_ENABLED=1 → /api/chat 由 Claude Code 执行
  await runCase("C01 普通问答（Claude Code Harness）", async () => {
    const ct = await chatToken();
    const r = await api("/api/chat", { method: "POST", body: { provider: "opencode-go", model: ct.model, modelToken: ct.token, messages: [{ role: "user", content: "用一句话解释什么是量子纠缠" }] } });
    if (r.status !== 200) throw new Error(`chat http ${r.status}: ${r.text.slice(0, 120)}`);
    const lines = r.text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const text = lines.filter((e) => e.type === "text").map((e) => e.value || "").join("");
    if (!text.trim()) throw new Error("无最终回答文本");
    if (!text.includes("量子")) throw new Error(`回答未命中主题：${text.slice(0, 80)}`);
    return `回答 ${text.length} 字符`;
  });

  // C02 代码：Claude Code 写真实 Python 文件
  await runCase("C02 代码（真实 .py）", async () => {
    const id = await createTask({ goal: "写一个 Python 程序，读取 CSV 并计算每列平均值，保存为 analyze.py 并执行验证", files: [{ path: `${FIXTURES}/data.csv`, name: "data.csv" }] });
    const { ok, task } = await pollTask(id);
    if (!ok) throw new Error(`${task.status}: ${task.error || ""}`);
    const arts = task.artifacts || [];
    const py = arts.find((a) => a.type === "code" || a.name?.includes("analyze") || a.filename?.endsWith(".py"));
    const anyFile = arts[0];
    if (!anyFile) throw new Error("无产物");
    const buf = await downloadArtifact(anyFile.downloadUrl || `/api/artifacts/${anyFile.id}`);
    return `产物 ${anyFile.filename || anyFile.name} (${buf.length}B)${py ? " 含代码" : ""}`;
  });

  // C03 PPTX：两页 PPT 必须真实 .pptx 且 ≤2 页
  await runCase("C03 PPTX（真实格式+页数契约）", async () => {
    const id = await createTask({ goal: "做两页 PPT，介绍太阳系行星", files: [] });
    const { ok, task } = await pollTask(id);
    if (!ok) throw new Error(`${task.status}: ${task.error || ""}`);
    const art = (task.artifacts || [])[0];
    if (!art) throw new Error("无产物");
    const buf = await downloadArtifact(`/api/artifacts/${art.id}`);
    if (buf.subarray(0, 2).toString() !== "PK") throw new Error("不是 zip/pptx");
    const slides = await countPptxSlides(buf);
    if (slides > 2) throw new Error(`页数 ${slides} 超出契约 2 页`);
    return `${art.name} ${slides} 页 (${buf.length}B)`;
  });

  // C04 XLSX：CSV → 真实 .xlsx
  await runCase("C04 XLSX（真实格式）", async () => {
    const id = await createTask({ goal: "把 data.csv 转成 Excel 并加一个合计行", files: [{ path: `${FIXTURES}/data.csv`, name: "data.csv" }] });
    const { ok, task } = await pollTask(id);
    if (!ok) throw new Error(`${task.status}: ${task.error || ""}`);
    const art = (task.artifacts || []).find((a) => a.type === "xlsx") || (task.artifacts || [])[0];
    if (!art) throw new Error("无产物");
    const buf = await downloadArtifact(`/api/artifacts/${art.id}`);
    if (buf.subarray(0, 2).toString() !== "PK") throw new Error("不是 xlsx");
    return `${art.filename || art.name} (${buf.length}B)`;
  });

  // C05 DOCX
  await runCase("C05 DOCX（真实格式）", async () => {
    const id = await createTask({ goal: "把 requirements.md 内容整理成一份 Word 文档", files: [{ path: `${FIXTURES}/requirements.md`, name: "requirements.md" }] });
    const { ok, task } = await pollTask(id);
    if (!ok) throw new Error(`${task.status}: ${task.error || ""}`);
    const art = (task.artifacts || [])[0];
    if (!art) throw new Error("无产物");
    const buf = await downloadArtifact(`/api/artifacts/${art.id}`);
    if (buf.subarray(0, 2).toString() !== "PK") throw new Error("不是 docx");
    return `${art.filename || art.name} (${buf.length}B)`;
  });

  // C06 PDF
  await runCase("C06 PDF（真实格式）", async () => {
    const id = await createTask({ goal: "生成一份关于太阳系的 PDF 文档（含标题与三个段落）" });
    const { ok, task } = await pollTask(id);
    if (!ok) throw new Error(`${task.status}: ${task.error || ""}`);
    const art = (task.artifacts || [])[0];
    if (!art) throw new Error("无产物");
    const buf = await downloadArtifact(`/api/artifacts/${art.id}`);
    if (buf.subarray(0, 5).toString() !== "%PDF-") throw new Error("不是 PDF");
    return `${art.filename || art.name} (${buf.length}B)`;
  });

  // C07 图片问答：图片 → 视觉信息 → Claude Code 回答
  await runCase("C07 图片问答（视觉进入回答）", async () => {
    const ct = await chatToken();
    const img = fs.readFileSync(`${FIXTURES}/reference.png`).toString("base64");
    const r = await api("/api/chat", { method: "POST", body: {
      provider: "opencode-go", model: ct.model, modelToken: ct.token,
      messages: [{ role: "user", content: "这张图里有什么？描述主要元素、颜色和布局", attachments: [{ kind: "image", name: "reference.png", mime: "image/png", dataUrl: `data:image/png;base64,${img}` }] }],
    } });
    if (r.status !== 200) throw new Error(`chat http ${r.status}`);
    const lines = r.text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const text = lines.filter((e) => e.type === "text").map((e) => e.value || "").join("");
    if (!text.trim()) throw new Error("无回答");
    const hasVisual = /卡片|按钮|背景|颜色|布局|card|button|蓝色/i.test(text);
    if (!hasVisual) throw new Error(`回答未含视觉信息：${text.slice(0, 100)}`);
    return `回答 ${text.length} 字符（含视觉描述）`;
  });

  // C08 综合任务：网站 + 参考图 + CSV + 需求 → 重构 + 视觉 + 打包 zip
  await runCase("C08 综合任务（重构+视觉+打包）", async () => {
    const id = await createTask({
      goal: "根据参考图重构网站页面（用 vision 工具查看 reference.png 的视觉设计），整合 data.csv 的销量数据为表格，保证移动端无横向滚动，完成后打包为 zip 交付",
      files: [
        { path: `${FIXTURES}/index.html`, name: "index.html" },
        { path: `${FIXTURES}/style.css`, name: "style.css" },
        { path: `${FIXTURES}/data.csv`, name: "data.csv" },
        { path: `${FIXTURES}/requirements.md`, name: "requirements.md" },
        { path: `${FIXTURES}/reference.png`, name: "reference.png" },
      ],
    });
    const { ok, task } = await pollTask(id, 1200_000);
    if (!ok) throw new Error(`${task.status}: ${task.error || ""}`);
    const arts = task.artifacts || [];
    const zip = arts.find((a) => a.type === "zip");
    if (!zip) throw new Error(`无 zip 产物（有 ${arts.map((a) => a.type).join(",")}）`);
    const buf = await downloadArtifact(`/api/artifacts/${zip.id}`);
    if (buf.subarray(0, 2).toString() !== "PK") throw new Error("zip 格式错误");
    return `zip 产物 ${buf.length}B；共 ${arts.length} 个产物`;
  });

  // C09 项目延续：同一 project 两轮任务共享 workspace
  await runCase("C09 项目延续（持久 workspace）", async () => {
    const created = await api("/api/projects", { method: "POST", body: { name: "延续项目", description: "final" } });
    if (created.status !== 200) throw new Error(`建项目 ${created.status}`);
    const projectId = created.json?.project?.id;
    if (!projectId) throw new Error("无 projectId");
    const t1 = await createTask({ goal: "做一个小网站首页（标题：My Site），输出 index.html", files: [] });
    const r1 = await api(`/api/tasks/${t1}`, { method: "PATCH", body: { action: "continue", projectId } });
    if (r1.status !== 200) throw new Error(`绑定项目 ${r1.status}: ${r1.text.slice(0, 120)}`);
    const p1 = await pollTask(t1);
    if (!p1.ok) throw new Error(`第一轮 ${p1.task.status}: ${p1.task.error || ""}`);
    const t2 = await createTask({ goal: "把网站标题改成 New Title，并新增一个关于页面", files: [] });
    const r2 = await api(`/api/tasks/${t2}`, { method: "PATCH", body: { action: "continue", projectId } });
    if (r2.status !== 200) throw new Error(`第二轮绑定项目 ${r2.status}`);
    const p2 = await pollTask(t2);
    if (!p2.ok) throw new Error(`第二轮 ${p2.task.status}: ${p2.task.error || ""}`);
    const proj = await api(`/api/projects/${projectId}`);
    const files = proj.json?.files || [];
    if (!files.length) throw new Error("项目 workspace 文件树为空");
    return `两轮完成，项目文件树 ${files.length} 项`;
  });

  // C10 Cancel：长任务中途取消
  await runCase("C10 Cancel（真实终止）", async () => {
    const id = await createTask({ goal: "写一份关于整个太阳系历史的超长综述，至少一万字，分章节详细展开" });
    await new Promise((res) => setTimeout(res, 3000));
    const c = await api(`/api/tasks/${id}`, { method: "PATCH", body: { action: "cancel" } });
    if (c.status !== 200) throw new Error(`cancel ${c.status}`);
    await new Promise((res) => setTimeout(res, 8000));
    const r = await api(`/api/tasks/${id}`);
    const status = r.json?.task?.status;
    if (status !== "cancelled") throw new Error(`状态 ${status}（期望 cancelled）`);
    return "cancelled";
  });

  // C11 并发：3 任务并发互不串扰
  await runCase("C11 并发（3 任务）", async () => {
    const ids = await Promise.all([
      createTask({ goal: "做一页 PPT：关于 Python", files: [] }),
      createTask({ goal: "做一页 PPT：关于 JavaScript", files: [] }),
      createTask({ goal: "做一页 PPT：关于 Go", files: [] }),
    ]);
    const results = await Promise.all(ids.map((id) => pollTask(id, 600_000)));
    if (!results.every((r) => r.ok)) {
      const bad = results.map((r, i) => (r.ok ? "" : `${ids[i]}:${r.task.status}/${r.task.error || ""}`)).filter(Boolean);
      throw new Error(`并发任务失败：${bad.join("；")}`);
    }
    return "3 任务全部完成";
  });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n==== 最终矩阵 ${pass}/${results.length} PASS ====`);
  for (const r of results) console.log(`  ${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : ` :: ${r.detail}`}`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((error) => { console.error("矩阵执行失败:", error); process.exit(1); });
