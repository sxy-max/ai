// Cancel 真终止——进程级深检查（配合 /tmp/cloud-verify-all.sh 编排）：
//   阶段1 running：外部编排者记录 file-agent 内 claude 进程数（应 >0）
//   阶段2 cancelled：编排者再记录（应 =0，断连 SIGKILL 生效）
// 本脚本只负责把任务推进到 cancelled，状态写入 /tmp/rec/cancel-phase.json。
import fs from "node:fs";

const BASE = process.env.E2E_BASE || "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "deep-cancel@test.local";
const PASSWORD = "DeepCancel-2026!";
const STATE = "/rec";

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
  return { status: resp.status, json, text, headers: resp.headers };
}
function writePhase(p) { try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(`${STATE}/cancel-phase.json`, JSON.stringify(p)); } catch {} }

async function main() {
  let r = await api("/api/auth/register", { method: "POST", body: { email: EMAIL, password: PASSWORD, inviteCode: INVITE } });
  if (r.status !== 200 && r.status !== 409 && r.status !== 429) throw new Error(`register ${r.status}`);
  if (r.status === 429) console.log("register rate-limited; reusing existing account");
  r = await api("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`login ${r.status}`);
  const sc = r.headers.getSetCookie?.() || [];
  cookie = (sc[0] || "").split(";")[0] || (r.headers.get("set-cookie") || "").split(";")[0];

  const created = await api("/api/tasks", { method: "POST", form: (() => {
    const form = new FormData();
    form.append("goal", "写一份关于银河系形成与演化的超长深度研究报告，至少一万字，分十二个章节，每章包含观测证据与理论细节");
    form.append("title", "deep-cancel");
    return form;
  })() });
  if (created.status !== 200) throw new Error(`create ${created.status}`);
  const taskId = created.json?.task?.id || created.json?.id;
  console.log("task:", taskId);

  const deadline = Date.now() + 120_000;
  let started = false;
  while (Date.now() < deadline) {
    const s = await api(`/api/tasks/${taskId}`);
    const status = s.json?.task?.status;
    if (status === "running") { started = true; break; }
    if (["completed", "failed", "cancelled"].includes(status)) throw new Error(`任务提前 ${status}`);
    await new Promise((res) => setTimeout(res, 2000));
  }
  if (!started) throw new Error("未进入 running");
  await new Promise((res) => setTimeout(res, 8000)); // 让 claude 真正启动
  writePhase({ phase: "running", taskId });
  console.log("phase=running（编排者记录 claude 进程数）");
  // 保持 running 观测窗口（编排者 3s 轮询捕捉 before 进程数；此前 2-3s 即取消导致窗口错过）
  await new Promise((res) => setTimeout(res, 20000));

  const c = await api(`/api/tasks/${taskId}`, { method: "PATCH", body: { action: "cancel" } });
  if (c.status !== 200) throw new Error(`cancel ${c.status}`);
  const cdl = Date.now() + 60_000;
  let cancelled = false;
  while (Date.now() < cdl) {
    const s = await api(`/api/tasks/${taskId}`);
    if (s.json?.task?.status === "cancelled") { cancelled = true; break; }
    await new Promise((res) => setTimeout(res, 2000));
  }
  if (!cancelled) throw new Error("状态未变 cancelled");
  writePhase({ phase: "cancelled", taskId });
  console.log("phase=cancelled（编排者复查 claude 进程数）");
  await new Promise((res) => setTimeout(res, 8000)); // 给 SIGKILL 生效窗口
  writePhase({ phase: "settled", taskId });
  console.log("phase=settled");
  process.exit(0);
}
main().catch((e) => { writePhase({ phase: "error", error: e.message }); console.error("FAIL:", e.message); process.exit(1); });
