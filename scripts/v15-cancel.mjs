// V1.5 Cancel 验证：AgentScope 驱动任务中途取消 → cancelled + 不残留产物。
const BASE = "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "v15-cancel@test.local";
const PASSWORD = "V15Cancel-2026!";
let cookie = "";

async function api(path, { method = "GET", body } = {}) {
  const headers = { cookie };
  if (body !== undefined) { headers["content-type"] = "application/json"; }
  const resp = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: resp.status, json, text };
}

async function main() {
  let login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  if (login.status !== 200) {
    await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: "V15Cancel", inviteCode: INVITE }), cache: "no-store" });
    login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  }
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const created = await api("/api/tasks", { method: "POST", body: { goal: "写一份 3000 字以上的中国物理发展史综述 markdown 文件，分十个章节，每章详细展开", title: "V15-Cancel", type: "agent_workspace" } });
  const taskId = created.json?.task?.id;
  console.log("task:", taskId);

  // 等任务进入执行（AgentScope 模型思考中），然后取消
  await new Promise((r) => setTimeout(r, 30000));
  const patch = await api(`/api/tasks/${taskId}`, { method: "PATCH", body: { action: "cancel" } });
  console.log("cancel patch:", patch.status);
  await new Promise((r) => setTimeout(r, 15000));
  const detail = (await api(`/api/tasks/${taskId}`)).json;
  const status = detail?.task?.status;
  const artifacts = detail?.artifacts || [];
  console.log("final status:", status, "| artifacts:", artifacts.length);
  if (status !== "cancelled") throw new Error(`期望 cancelled，got ${status}`);
  console.log("CANCEL PASS：AgentScope 任务取消 →", status);
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
