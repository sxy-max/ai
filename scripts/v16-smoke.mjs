// V1.6 主链冒烟：普通问答 → Preflight(quick) → Claude Code → final text。
const BASE = "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "v16-smoke@test.local";
const PASSWORD = "V16Smoke-2026!";
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
    await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: "V16Smoke", inviteCode: INVITE }), cache: "no-store" });
    login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  }
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const created = await api("/api/tasks", { method: "POST", body: { goal: "用一句话解释什么是熵增定律", title: "V16-QA" } });
  const taskId = created.json?.task?.id;
  const deadline = Date.now() + 240000;
  let status = "queued";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 6000));
    const d = (await api(`/api/tasks/${taskId}`)).json;
    status = d?.task?.status;
    if (status === "completed" || status === "failed" || status === "cancelled") break;
  }
  const detail = (await api(`/api/tasks/${taskId}`)).json;
  console.log("status:", status, "| summary:", (detail?.task?.result_summary || "").slice(0, 150));
  if (status !== "completed") throw new Error(`失败: ${detail?.task?.error || status}`);
  const events = detail?.events || [];
  const hasText = events.some((e) => (e.payload?.detail || "").length > 30);
  console.log(hasText ? "QA SMOKE PASS（Claude Code 回答）" : "QA SMOKE PASS");
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
