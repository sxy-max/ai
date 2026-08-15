// V1.4 云端真实矩阵（WP71 C01-C17）：产物必须是真实文件，禁止 Markdown 冒充。
// 运行：docker run --rm --network go-ai-net --env-file /opt/ai-client/.env
//       -v /tmp/cloud-v14.mjs:/v14.mjs ai-client:v1.4 node /v14.mjs
import fs from "node:fs";

const BASE = process.env.E2E_BASE || "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "cloud-v14-fixed@test.local";
const PASSWORD = "CloudV14-2026!";

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

async function pollTask(taskId, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api(`/api/tasks/${taskId}`);
    const t = r.json?.task || {};
    if (t.status === "completed") return { ok: true, task: t };
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

async function main() {
  let login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  if (login.status !== 200) {
    const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: "CloudV14", inviteCode: INVITE }), cache: "no-store" });
    if (reg.status !== 200) throw new Error(`注册失败 ${reg.status}`);
    login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  }
  const setCookie = login.headers.get("set-cookie") || "";
  cookie = setCookie.split(";")[0];

  let projectId = "";
  let pptTaskId = "";

  await runCase("C01 短任务 markdown 产物", async () => {
    const id = await createTask({ type: "artifact", goal: "写一篇关于拉格朗日力学的中文介绍（markdown）", title: "C01" });
    const r = await pollTask(id);
    if (!r.ok) throw new Error(`status=${r.task.status} ${r.task.error || ""}`);
    const arts = (await api(`/api/tasks/${id}`)).json?.artifacts || [];
    const md = arts.find((a) => a.type === "markdown" || a.name.endsWith(".md"));
    if (!md) throw new Error(`无 markdown 产物: ${arts.map((a) => a.type).join(",")}`);
    const buf = await downloadArtifact(md.downloadUrl);
    if (buf.length < 50) throw new Error("markdown 产物过小");
    return `${md.name} ${buf.length}B`;
  });

  await runCase("C02 PPTX 两页真实文件", async () => {
    pptTaskId = await createTask({ type: "artifact", goal: "把「旋转圆环小珠」做成两页大学物理课程 PPT：第一页问题与模型与拉格朗日量，第二页平衡、稳定性、临界角速度、小振动", title: "C02" });
    const r = await pollTask(pptTaskId);
    if (!r.ok) throw new Error(`status=${r.task.status}`);
    const arts = (await api(`/api/tasks/${pptTaskId}`)).json?.artifacts || [];
    const pptx = arts.find((a) => a.type === "pptx" || a.name.endsWith(".pptx"));
    if (!pptx) throw new Error(`无 pptx 产物: ${arts.map((a) => a.type).join(",")}`);
    const buf = await downloadArtifact(pptx.downloadUrl);
    if (buf.subarray(0, 2).toString() !== "PK") throw new Error("非 ZIP/PPTX 容器");
    const JSZip = (await import(process.cwd() + "/node_modules/jszip/index.js")).default;
    const z = await JSZip.loadAsync(buf);
    const slides = Object.keys(z.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    if (slides.length !== 2) throw new Error(`页数=${slides.length}，应为 2（无封面页）`);
    const s1 = await z.file(slides[0])?.async("string");
    if (!s1.includes("拉格朗日")) throw new Error("第一页缺拉格朗日内容");
    return `${slides.length} 页，内容完整`;
  });

  await runCase("C03 CSV→XLSX 真实表格", async () => {
    const csv = Buffer.from("姓名,数学,语文\n张三,85,90\n李四,92,88\n王五,76,82", "utf8");
    fs.writeFileSync("/fixtures/scores.csv", csv);
    const id = await createTask({ type: "agent_workspace", goal: "把这个 CSV 转成 Excel 并新增平均分列", title: "C03", files: [{ path: "/fixtures/scores.csv", name: "scores.csv" }] });
    const r = await pollTask(id);
    if (!r.ok) throw new Error(`status=${r.task.status}`);
    const arts = (await api(`/api/tasks/${id}`)).json?.artifacts || [];
    const xlsx = arts.find((a) => a.type === "xlsx" || a.name.endsWith(".xlsx"));
    if (!xlsx) throw new Error(`无 xlsx: ${arts.map((a) => a.type).join(",")}`);
    const buf = await downloadArtifact(xlsx.downloadUrl);
    if (buf.subarray(0, 2).toString() !== "PK") throw new Error("非 xlsx");
    return `${xlsx.name} ${buf.length}B`;
  });

  await runCase("C04 DOCX 真实文档", async () => {
    const id = await createTask({ type: "artifact", goal: "把以下内容整理成 Word 文档：\n# 牛顿第二定律\n\nF = ma\n\n- 力是矢量\n- 质量是标量", title: "C04" });
    const r = await pollTask(id);
    if (!r.ok) throw new Error(`status=${r.task.status}`);
    const arts = (await api(`/api/tasks/${id}`)).json?.artifacts || [];
    const docx = arts.find((a) => a.type === "docx" || a.name.endsWith(".docx"));
    if (!docx) throw new Error(`无 docx: ${arts.map((a) => a.type).join(",")}`);
    const buf = await downloadArtifact(docx.downloadUrl);
    if (buf.subarray(0, 2).toString() !== "PK") throw new Error("非 docx");
    return `${docx.name} ${buf.length}B`;
  });

  await runCase("C05 PDF 真实文件", async () => {
    const id = await createTask({ type: "artifact", goal: "把这篇内容做成 PDF：\n# 旋转圆环小珠\n\n拉格朗日量 L = ½mR²(θ̇² + ω²sin²θ) − mgR(1−cosθ)", title: "C05" });
    const r = await pollTask(id);
    if (!r.ok) throw new Error(`status=${r.task.status}`);
    const arts = (await api(`/api/tasks/${id}`)).json?.artifacts || [];
    const pdf = arts.find((a) => a.type === "pdf" || a.name.endsWith(".pdf"));
    if (!pdf) throw new Error(`无 pdf: ${arts.map((a) => a.type).join(",")}`);
    const buf = await downloadArtifact(pdf.downloadUrl);
    if (buf.subarray(0, 5).toString() !== "%PDF-") throw new Error("非 PDF 头");
    if (buf.length < 500) throw new Error("PDF 过小");
    return `${pdf.name} ${buf.length}B`;
  });

  await runCase("C08 ZIP 项目修改", async () => {
    const JSZip = (await import(process.cwd() + "/node_modules/jszip/index.js")).default;
    const site = new JSZip();
    site.file("index.html", "<!doctype html><h1>旧标题</h1><style>body{background:#fff}</style>");
    site.file("style.css", "body{background:#fff}");
    const zipBuf = await site.generateAsync({ type: "nodebuffer" });
    fs.writeFileSync("/fixtures/site.zip", zipBuf);
    const id = await createTask({ type: "agent_workspace", goal: "把网站标题改为「新标题」并把背景改成深色", title: "C08", files: [{ path: "/fixtures/site.zip", name: "site.zip" }] });
    const r = await pollTask(id);
    if (!r.ok) throw new Error(`status=${r.task.status}`);
    const arts = (await api(`/api/tasks/${id}`)).json?.artifacts || [];
    const out = arts.find((a) => a.name.endsWith(".zip") || a.type === "zip");
    if (!out) throw new Error(`无 zip: ${arts.map((a) => a.name).join(",")}`);
    const buf = await downloadArtifact(out.downloadUrl);
    const JSZip2 = (await import(process.cwd() + "/node_modules/jszip/index.js")).default;
    const oz = await JSZip2.loadAsync(buf);
    const html = await oz.file("index.html")?.async("string");
    if (!html.includes("新标题")) throw new Error(`index.html 未修改（${html?.slice(0, 60)}）`);
    return "index.html 已修改";
  });

  await runCase("C09 项目延续：两轮共享 workspace", async () => {
    const proj = await api("/api/projects", { method: "POST", body: { name: "V14 延续项目" } });
    projectId = proj.json?.project?.id;
    if (!projectId) throw new Error("创建项目失败");
    const JSZip = (await import(process.cwd() + "/node_modules/jszip/index.js")).default;
    const site = new JSZip();
    site.file("index.html", "<!doctype html><h1>标题一</h1>");
    const zipBuf = await site.generateAsync({ type: "nodebuffer" });
    fs.writeFileSync("/fixtures/cont.zip", zipBuf);
    // 第一轮：上传 zip 改标题
    const t1 = await api("/api/tasks", { method: "POST", form: multipart({ goal: "把网站标题改为「标题二」", title: "C09-1", type: "agent_workspace", projectId }, [{ path: "/fixtures/cont.zip", name: "cont.zip" }]) });
    const id1 = t1.json?.task?.id || t1.json?.id;
    const r1 = await pollTask(id1);
    if (!r1.ok) throw new Error(`第一轮 status=${r1.task.status}`);
    // 第二轮：不重新上传，继续改（同项目）
    const t2 = await api("/api/tasks", { method: "POST", form: multipart({ goal: "继续：把标题改为「标题三」并保持其他不动", title: "C09-2", type: "agent_workspace", projectId }) });
    const id2 = t2.json?.task?.id || t2.json?.id;
    const r2 = await pollTask(id2);
    if (!r2.ok) throw new Error(`第二轮 status=${r2.task.status}`);
    const arts2 = (await api(`/api/tasks/${id2}`)).json?.artifacts || [];
    if (!arts2.length) throw new Error("第二轮无产物");
    // 项目历史：产物版本追踪
    const detail = await api(`/api/projects/${projectId}`);
    const hist = detail.json?.artifacts || [];
    if (hist.length < 1) throw new Error("项目历史为空");
    return `${hist.length} 个历史产物，两轮任务均完成`;
  });

  await runCase("C12 并发 3 任务", async () => {
    const goals = [
      "写一段关于热力学第二定律的中文介绍（markdown）",
      "把「万有引力」做成两页物理 PPT",
      "写一篇关于光学干涉的中文短文（markdown）",
    ];
    const ids = [];
    for (const goal of goals) ids.push(await createTask({ type: "artifact", goal, title: "C12" }));
    const settled = await Promise.all(ids.map((id) => pollTask(id, 600_000)));
    const okCount = settled.filter((r) => r.ok).length;
    if (okCount < 3) throw new Error(`完成 ${okCount}/3`);
    return `3/3 完成`;
  });

  await runCase("C17 项目历史 API", async () => {
    if (!projectId) throw new Error("无项目");
    const detail = await api(`/api/projects/${projectId}`);
    const body = detail.json || {};
    if (!body.project) throw new Error("项目详情缺失");
    const hasFiles = Array.isArray(body.files);
    if (!hasFiles) throw new Error("files 字段缺失");
    return `project+artifacts(${body.artifacts?.length || 0})+files(${body.files?.length || 0})`;
  });

  console.log(`\n===== V1.4 云端矩阵 =====`);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(2); });
