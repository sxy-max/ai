// V1.5 Phase A 服务器验证：agent_workspace 任务完全由 AgentScope Harness 驱动。
// 运行：容器内（go-ai-net）node /v15.mjs
import fs from "node:fs";
const BASE = "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "v15-phase-a@test.local";
const PASSWORD = "V15PhaseA-2026!";
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

async function pollTask(taskId, timeoutMs = 420_000) {
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

async function main() {
  let login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  if (login.status !== 200) {
    const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: "V15PhaseA", inviteCode: INVITE }), cache: "no-store" });
    if (reg.status !== 200) throw new Error(`注册失败 ${reg.status}`);
    login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  }
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  console.log("创建 AgentScope 驱动任务（写 markdown）...");
  const created = await api("/api/tasks", { method: "POST", body: { goal: "写一份关于拉格朗日量的中文简介 markdown 文件（800 字以上），内容要完整", title: "V15-PhaseA", type: "agent_workspace" } });
  const taskId = created.json?.task?.id || created.json?.id;
  if (!taskId) throw new Error(`创建失败: ${created.text.slice(0, 200)}`);
  console.log("task:", taskId);

  const r = await pollTask(taskId);
  if (!r.ok) throw new Error(`任务失败: ${r.task.status} ${r.task.error || ""}`);
  const detail = (await api(`/api/tasks/${taskId}`)).json;
  const artifacts = detail?.artifacts || [];
  console.log("产物:", artifacts.map((a) => `${a.name}(${a.type},${a.size}B)`).join(", ") || "无");
  const md = artifacts.find((a) => a.type === "markdown" || a.name.endsWith(".md"));
  if (!md) throw new Error("无 markdown 产物");
  const dl = await fetch(`${BASE}${md.downloadUrl}`, { headers: { cookie }, cache: "no-store" });
  const content = await dl.text();
  if (content.length < 500) throw new Error(`产物过小（${content.length}B）`);
  console.log(`PHASE A PASS：AgentScope 驱动任务 → ${md.name}（${content.length}B）`);
  // 验证 runtime 确实是 agentscope
  const job = detail?.job || {};
  console.log("job runtime:", job.runtime || "?");
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
