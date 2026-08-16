// V1.5 默认路径冒烟：无 FORCE 开关，任务自动走 AgentScope（job runtime 验证）。
const BASE = "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "v15-default@test.local";
const PASSWORD = "V15Default-2026!";
let cookie = "";
async function api(path, { method = "GET", body } = {}) {
  const headers = { cookie };
  if (body !== undefined) headers["content-type"] = "application/json";
  const resp = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: resp.status, json, text };
}
async function main() {
  let login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  if (login.status !== 200) {
    await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: "V15Default", inviteCode: INVITE }), cache: "no-store" });
    login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  }
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const created = await api("/api/tasks", { method: "POST", body: { goal: "写一份关于量子纠缠的中文简介 markdown 到 output/", title: "V15-Default", type: "agent_workspace" } });
  const taskId = created.json?.task?.id;
  const deadline = Date.now() + 420000;
  let status = "queued";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    const d = (await api(`/api/tasks/${taskId}`)).json;
    status = d?.task?.status;
    if (status === "completed" || status === "failed" || status === "cancelled") break;
  }
  const detail = (await api(`/api/tasks/${taskId}`)).json;
  const artifacts = detail?.artifacts || [];
  const job = detail?.job || {};
  console.log("status:", status, "| runtime:", job.runtime || "?", "| artifacts:", artifacts.map((a) => `${a.name}(${a.size}B)`).join(", ") || "无");
  if (status !== "completed") throw new Error(`失败: ${detail?.task?.error || status}`);
  if (job.runtime !== "agentscope") throw new Error(`期望 agentscope runtime，got ${job.runtime}`);
  console.log("DEFAULT PATH PASS：无开关任务自动走 AgentScope ✓");
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
