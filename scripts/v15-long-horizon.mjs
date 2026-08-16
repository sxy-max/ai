// V1.5 长任务验证：AgentScope 驱动长文本生成（多轮工具调用）。
const BASE = "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "v15-long@test.local";
const PASSWORD = "V15Long-2026!";
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
    await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: "V15Long", inviteCode: INVITE }), cache: "no-store" });
    login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  }
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const created = await api("/api/tasks", { method: "POST", body: { goal: "写一份 2000 字以上的中国物理发展史综述 markdown 文件，分 5 个章节，每章至少 400 字", title: "V15-Long", type: "agent_workspace" } });
  const taskId = created.json?.task?.id;
  const t0 = Date.now();
  const deadline = Date.now() + 600000;
  let status = "queued";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    const d = (await api(`/api/tasks/${taskId}`)).json;
    status = d?.task?.status;
    if (status === "completed" || status === "failed" || status === "cancelled") break;
  }
  const detail = (await api(`/api/tasks/${taskId}`)).json;
  const artifacts = detail?.artifacts || [];
  console.log("status:", status, "| duration:", Math.round((Date.now() - t0) / 1000) + "s", "| artifacts:", artifacts.map((a) => `${a.name}(${a.size}B)`).join(", ") || "无");
  if (status !== "completed") throw new Error(`长任务失败: ${status} ${detail?.task?.error || ""}`);
  const md = artifacts.find((a) => a.type === "markdown" || a.name.endsWith(".md"));
  if (!md || md.size < 1500) throw new Error("长任务产物不足");
  console.log("LONG HORIZON PASS：AgentScope 长任务 →", md.name, md.size + "B");
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
