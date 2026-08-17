// Cancel 真终止专项验证（2026-08-17 修复后）：
// 1) cancel 后任务状态 cancelled；
// 2) file-agent 容器内 claude 进程在 cancel 后快速消失（断连 kill，非 15 分钟超时）；
// 3) worker 立即领取下一个任务（不阻塞队列）。
// 运行：服务器容器内执行；FILE_AGENT 容器内进程数经 docker exec 由脚本外检查。
import fs from "node:fs";

const BASE = process.env.E2E_BASE || "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "cancel-check@test.local";
const PASSWORD = "CancelCheck-2026!";

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

async function login() {
  let r = await api("/api/auth/register", { method: "POST", body: { email: EMAIL, password: PASSWORD, inviteCode: INVITE } });
  if (r.status !== 200 && r.status !== 409) throw new Error(`register ${r.status}`);
  r = await api("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`login ${r.status}`);
  const sc = r.headers.getSetCookie?.() || [];
  cookie = (sc[0] || "").split(";")[0];
  if (!cookie) cookie = (r.headers.get("set-cookie") || "").split(";")[0];
}

async function waitStatus(taskId, want, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api(`/api/tasks/${taskId}`);
    if (r.json?.task?.status === want) return true;
    if (["failed", "cancelled", "completed"].includes(r.json?.task?.status) && r.json?.task?.status !== want) return false;
    await new Promise((res) => setTimeout(res, 2000));
  }
  return false;
}

async function main() {
  await login();
  // 1. 创建长任务（目标：执行期间 cancel，验证 claude 被 kill）
  const created = await api("/api/tasks", { method: "POST", form: (() => {
    const form = new FormData();
    form.append("goal", "写一份关于火星殖民计划的超长深度研究报告，至少八千字，分十个章节，每章详细展开技术方案与社会影响");
    form.append("title", "cancel-verify");
    return form;
  })() });
  if (created.status !== 200) throw new Error(`create ${created.status}`);
  const taskId = created.json?.task?.id || created.json?.id;
  console.log("task:", taskId);
  // 等它进入 running（worker 领取并开始执行）
  const started = await waitStatus(taskId, "running", 60_000);
  console.log("running:", started);
  await new Promise((res) => setTimeout(res, 5000)); // 让 claude 启动
  // 2. cancel
  const c = await api(`/api/tasks/${taskId}`, { method: "PATCH", body: { action: "cancel" } });
  console.log("cancel status:", c.status);
  // 3. 状态 cancelled
  const ok = await waitStatus(taskId, "cancelled", 60_000);
  console.log("cancelled:", ok);
  if (!ok) { console.log("FAIL: 状态未变为 cancelled"); process.exit(1); }
  // 4. 立即创建下一个任务，验证 worker 不阻塞（cancel 后 ~10 秒内能领取）
  const t0 = Date.now();
  const next = await api("/api/tasks", { method: "POST", form: (() => {
    const form = new FormData();
    form.append("goal", "做一页 PPT：关于 Cancel 验证");
    form.append("title", "cancel-next");
    return form;
  })() });
  const nextId = next.json?.task?.id || next.json?.id;
  const nextOk = await waitStatus(nextId, "completed", 180_000);
  console.log(`下一任务 ${nextOk ? "完成" : "失败/超时"}（cancel 后 ${Math.round((Date.now() - t0) / 1000)}s 创建）`);
  if (!nextOk) { console.log("FAIL: cancel 后队列被阻塞"); process.exit(1); }
  console.log("PASS: cancel 真终止（状态 + 队列不阻塞；claude 进程消失由外部 docker exec 检查）");
  process.exit(0);
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
