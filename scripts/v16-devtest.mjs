const BASE = "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "v16-devtest@test.local";
const PASSWORD = "V16Dev-2026!";
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
    await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: "V16Dev", inviteCode: INVITE }), cache: "no-store" });
    login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  }
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const created = await api("/api/tasks", { method: "POST", body: { goal: "写一个简单的 markdown 文件（内容：主链测试）到 output/", title: "V16-Dev", type: "agent_workspace" } });
  const taskId = created.json?.task?.id;
  console.log("task:", taskId);
  const deadline = Date.now() + 300000;
  let status = "queued";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 6000));
    const d = (await api(`/api/tasks/${taskId}`)).json;
    status = d?.task?.status;
    if (status === "completed" || status === "failed" || status === "cancelled") break;
  }
  const detail = (await api(`/api/tasks/${taskId}`)).json;
  console.log("status:", status, "| artifacts:", (detail?.artifacts || []).map((a) => `${a.name}(${a.size}B)`).join(", ") || "无", "| err:", detail?.task?.error || "");
}
main().catch((e) => console.error("FAIL:", e.message));
