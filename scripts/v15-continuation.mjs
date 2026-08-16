// V1.5 项目延续专项：AgentScope 驱动两轮共享 workspace（不重新上传）。
const BASE = "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "v15-cont@test.local";
const PASSWORD = "V15Cont-2026!";
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

async function pollTask(taskId, timeoutMs = 420_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api(`/api/tasks/${taskId}`);
    const t = r.json?.task || {};
    if (t.status === "completed") return { ok: true };
    if (t.status === "failed" || t.status === "cancelled") return { ok: false, task: t };
    await new Promise((res) => setTimeout(res, 5000));
  }
  return { ok: false, task: { status: "timeout" } };
}

async function main() {
  let login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  if (login.status !== 200) {
    await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: "V15Cont", inviteCode: INVITE }), cache: "no-store" });
    login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  }
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const proj = await api("/api/projects", { method: "POST", body: { name: "V15 延续" } });
  const projectId = proj.json?.project?.id;

  const html = Buffer.from("<!doctype html><h1>标题一</h1>");
  const t1 = await api("/api/tasks", { method: "POST", form: multipart({ goal: "把网站标题改为「标题二」", title: "V15C-1", type: "agent_workspace", projectId }, [{ name: "index.html", buf: html }]) });
  const id1 = t1.json?.task?.id;
  console.log("round1:", id1);
  const r1 = await pollTask(id1);
  if (!r1.ok) throw new Error(`第一轮失败: ${r1.task?.status} ${r1.task?.error || ""}`);
  console.log("round1 PASS");

  const t2 = await api("/api/tasks", { method: "POST", form: multipart({ goal: "继续：把标题改为「标题三」并保持其他不动", title: "V15C-2", type: "agent_workspace", projectId }) });
  const id2 = t2.json?.task?.id;
  console.log("round2:", id2);
  const r2 = await pollTask(id2);
  if (!r2.ok) throw new Error(`第二轮失败: ${r2.task?.status} ${r2.task?.error || ""}`);
  console.log("round2 PASS");

  const detail = await api(`/api/projects/${projectId}`);
  const hist = detail.json?.artifacts || [];
  console.log("项目历史产物:", hist.length, hist.map((a) => `${a.name} v${a.version}`).join(", "));
  if (hist.length < 2) throw new Error("延续历史不足");
  console.log("CONTINUATION PASS：两轮 AgentScope 驱动 + 项目工作区延续 ✓");
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
