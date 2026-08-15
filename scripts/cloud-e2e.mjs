// 云端真实 E2E（V1.2 WP33）：任务系统全链路（登录→任务→轮询→产物→continue）
// 运行：docker run --rm --network go-ai-net --env-file /opt/ai-client/.env
//       -v /tmp/e2e-fixtures:/fixtures -v /tmp/cloud-e2e.mjs:/e2e.mjs
//       ai-client:v1.2 node /e2e.mjs
import fs from "node:fs";

const BASE = process.env.E2E_BASE || "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "cloud-e2e-fixed@test.local"; // 固定账号：登录优先，注册失败降级（容器同 IP 限流）
const PASSWORD = "CloudE2E-2026!";

let cookie = "";
const results = [];

async function api(path, { method = "GET", body, form } = {}) {
  const headers = { cookie };
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const resp = await fetch(`${BASE}${path}`, { method, headers, body: payload, cache: "no-store" });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: resp.status, json, text };
}

function multipart(fields, files) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files || []) {
    const buf = fs.readFileSync(f.path);
    form.append("files", new Blob([buf]), f.name);
  }
  return form;
}

async function pollTask(taskId, timeoutMs = 300_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { json } = await api(`/api/tasks/${taskId}`);
    const status = json?.task?.status;
    if (status === "completed") return { ok: true, task: json.task };
    if (status === "failed" || status === "cancelled") return { ok: false, task: json.task, error: json.task?.error };
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { ok: false, error: "timeout" };
}

async function createTask({ type, goal, title, files }) {
  const form = multipart({ goal, type, title }, files);
  const { status, json } = await api("/api/tasks", { method: "POST", form });
  if (status !== 200) throw new Error(`创建任务失败 ${status}: ${JSON.stringify(json)}`);
  return json.task.id;
}

async function runCase(name, fn) {
  try {
    const result = await fn();
    results.push({ name, ok: true, detail: result });
    console.log(`✓ ${name} — ${result}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    console.log(`✗ ${name} — ${error.message}`);
  }
}

const FIX = "/fixtures";

async function main() {
  // 登录优先（固定账号幂等）；首次运行注册
  let loginResp = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  if (loginResp.status !== 200) {
    const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: "CloudE2E", inviteCode: INVITE }), cache: "no-store" });
    if (reg.status !== 200) throw new Error(`注册失败 ${reg.status} ${(await reg.text()).slice(0, 200)}`);
    loginResp = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  }
  cookie = (loginResp.headers.get("set-cookie") || "").split(";")[0] || "";
  if (!cookie) throw new Error("登录未返回 cookie");
  console.log("登录成功:", EMAIL);

  // E1: 模型列表（真实 provider 探测）
  await runCase("E1 models + deepseek chat", async () => {
    const models = await api("/api/models");
    const keys = (models.json?.models || []).map((m) => m.key);
    if (!keys.includes("deepseek-v4-pro")) throw new Error("deepseek-v4-pro 不在模型列表");
    const target = models.json.models.find((m) => m.key === "deepseek-v4-flash") || models.json.models.find((m) => m.key === "deepseek-v4-pro");
    const chat = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ provider: "opencode-go", model: target.key, modelToken: target.modelToken, messages: [{ role: "user", content: "说一个字：好" }], options: { maxOutputTokens: 64 } }),
      cache: "no-store",
    });
    if (!chat.ok) throw new Error(`chat HTTP ${chat.status}`);
    const reader = chat.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        try { const ev = JSON.parse(line.trim()); if (ev.type === "text") text += ev.value || ""; } catch {}
      }
    }
    if (!text.trim()) throw new Error("chat 无文本响应");
    return `模型 ${keys.length} 个，chat 响应: ${text.trim().slice(0, 20)}`;
  });

  // E2: MD 任务（Claude Code runtime）
  let mdTaskId;
  await runCase("E2 MD agent task (claude-code)", async () => {
    mdTaskId = await createTask({
      type: "agent_workspace",
      goal: "把 note.md 整理成结构化文章并输出 markdown",
      title: "E2-MD",
      files: [{ name: "note.md", path: `${FIX}/note.md` }],
    });
    const result = await pollTask(mdTaskId);
    if (!result.ok) throw new Error(result.error || "任务失败");
    const arts = await api(`/api/tasks/${mdTaskId}`);
    const artifacts = arts.json?.artifacts || [];
    if (!artifacts.length) throw new Error("无产物");
    return `产物: ${artifacts.map((a) => `${a.name} v${a.version}`).join(", ")}`;
  });

  // E3: CSV 去重排序
  await runCase("E3 CSV dedupe+sort (claude-code)", async () => {
    const id = await createTask({
      type: "agent_workspace",
      goal: "读取 data.csv，删除重复行并按第二列升序排序，输出新 CSV",
      title: "E3-CSV",
      files: [{ name: "data.csv", path: `${FIX}/data.csv` }],
    });
    const result = await pollTask(id);
    if (!result.ok) throw new Error(result.error || "任务失败");
    const arts = await api(`/api/tasks/${id}`);
    const artifacts = arts.json?.artifacts || [];
    const csvArtifact = artifacts.find((a) => a.type === "csv" || a.name.endsWith(".csv"));
    if (!csvArtifact) throw new Error("无 CSV 产物");
    // 下载验证内容
    const dl = await fetch(`${BASE}${csvArtifact.downloadUrl}`, { headers: { cookie }, cache: "no-store" });
    const content = await dl.text();
    if (!content.includes("bob,10")) throw new Error("排序/去重结果不符");
    return `CSV 内容验证通过（${content.split("\n").length} 行）`;
  });

  // E4: PPTX（deterministic）
  await runCase("E4 PPTX two slides", async () => {
    const id = await createTask({ type: "artifact", goal: "做一份两页 PPT：第一页介绍项目背景，第二页列出三个要点", title: "E4-PPTX" });
    const result = await pollTask(id);
    if (!result.ok) throw new Error(result.error || "任务失败");
    const arts = await api(`/api/tasks/${id}`);
    const artifacts = arts.json?.artifacts || [];
    const pptx = artifacts.find((a) => a.type === "pptx");
    if (!pptx) throw new Error("无 PPTX 产物");
    const dl = await fetch(`${BASE}${pptx.downloadUrl}`, { headers: { cookie }, cache: "no-store" });
    const buf = Buffer.from(await dl.arrayBuffer());
    if (!buf.subarray(0, 2).toString() === "PK") throw new Error("PPTX 不是 ZIP 容器");
    return `PPTX ${buf.length} bytes`;
  });

  // E5+E6: 图片+HTML（vision 预处理 + agent 修改）
  await runCase("E6 image+HTML (vision->agent)", async () => {
    const id = await createTask({
      type: "agent_workspace",
      goal: "按 reference.png 截图重做 index.html 的样式",
      title: "E6-IMG-HTML",
      files: [
        { name: "reference.png", path: `${FIX}/reference.png` },
        { name: "index.html", path: `${FIX}/index.html` },
      ],
    });
    const result = await pollTask(id);
    if (!result.ok) throw new Error(result.error || "任务失败");
    const arts = await api(`/api/tasks/${id}`);
    const artifacts = arts.json?.artifacts || [];
    const html = artifacts.find((a) => a.type === "html" || a.name.endsWith(".html"));
    if (!html) throw new Error("无 HTML 产物");
    return `HTML 产物: ${html.name} v${html.version}`;
  });

  // E7: ZIP 项目修改
  await runCase("E7 ZIP project modify", async () => {
    const id = await createTask({
      type: "agent_workspace",
      goal: "解压 site.zip，把 index.html 的标题改成「云端工作台」，重新打包输出 zip",
      title: "E7-ZIP",
      files: [{ name: "site.zip", path: `${FIX}/site.zip` }],
    });
    const result = await pollTask(id);
    if (!result.ok) throw new Error(result.error || "任务失败");
    const arts = await api(`/api/tasks/${id}`);
    const artifacts = arts.json?.artifacts || [];
    const zip = artifacts.find((a) => a.type === "zip" || a.name.endsWith(".zip"));
    if (!zip) throw new Error("无 ZIP 产物");
    return `ZIP 产物: ${zip.name} v${zip.version}`;
  });

  // E9: continuation（二轮修改）
  if (mdTaskId) {
    await runCase("E9 continuation (2nd round)", async () => {
      const patch = await api(`/api/tasks/${mdTaskId}`, { method: "PATCH", body: { action: "continue", goal: "把标题改成加粗" } });
      if (patch.status !== 200) throw new Error(`continue ${patch.status}`);
      const result = await pollTask(mdTaskId);
      if (!result.ok) throw new Error(result.error || "任务失败");
      const arts = await api(`/api/tasks/${mdTaskId}`);
      const artifacts = arts.json?.artifacts || [];
      const versions = artifacts.map((a) => a.version);
      if (!versions.includes(2)) throw new Error("无 v2 产物（版本化未生效）");
      return `v2 产物存在（版本 ${versions.join(",")}）`;
    });
  }

  // E10: artifact 下载 + 归属
  await runCase("E10 artifact download", async () => {
    if (!mdTaskId) throw new Error("无任务引用");
    const arts = await api(`/api/tasks/${mdTaskId}`);
    const artifacts = arts.json?.artifacts || [];
    if (!artifacts.length) throw new Error("无产物可下载");
    const art = artifacts[0];
    const dl = await fetch(`${BASE}${art.downloadUrl}`, { headers: { cookie }, cache: "no-store" });
    if (dl.status !== 200) throw new Error(`下载 HTTP ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length === 0) throw new Error("产物为空");
    return `下载 ${art.name} v${art.version}（${buf.length} bytes）`;
  });

  console.log("\n===== CLOUD E2E SUMMARY =====");
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
  console.log(`${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("E2E 异常:", e.message); process.exit(1); });
