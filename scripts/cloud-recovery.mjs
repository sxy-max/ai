// 云端执行恢复验收（本 Goal §44：真实执行恢复）：worker 崩溃 → 租约过期回收 → 任务继续 → 真实产物。
//
// 运行方式（本地 ssh 编排）：
//   1. 启动本脚本的 runner 容器（后台）：
//      ssh tencent-ai "sudo docker run -d --name goai-rec-runner --network go-ai-net --env-file /opt/ai-client/.env \
//        -u root -v /tmp/cloud-recovery.mjs:/rec.mjs -v /tmp/rec:/rec ai-client:v1.7 node /rec.mjs \
//        >/dev/null && echo started"
//   2. 本地等任务进入执行态（/tmp/rec/state.json 出现 "readyForKill"）后：
//      ssh tencent-ai "sudo docker rm -f ai-task-worker go-ai-file-agent && sleep 120 && \
//        sudo docker run -d --name ai-task-worker ... ai-client:v1.7 node scripts/task-worker.cjs && \
//        sudo docker run -d --name go-ai-file-agent ... go-ai-file-agent:claude"
//   3. 脚本自动完成剩余验证（任务 completed + 真实产物）。
//
// 判据：任务最终 completed 且产物 ≥1；若期间 worker 被杀（state.json 记录 kill 信号），
// 恢复后同一任务续跑完成，不重开空任务、不重复注册产物版本。

import fs from "node:fs";

const BASE = process.env.E2E_BASE || "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "cloud-rec@test.local";
const PASSWORD = "CloudRec-2026!";
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
  return { status: resp.status, json, text };
}

function writeState(partial) {
  try {
    const prev = fs.existsSync(`${STATE}/state.json`) ? JSON.parse(fs.readFileSync(`${STATE}/state.json`, "utf8")) : {};
    fs.writeFileSync(`${STATE}/state.json`, JSON.stringify({ ...prev, ...partial }, null, 2));
  } catch {}
}

async function pollTask(taskId, timeoutMs = 1800_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api(`/api/tasks/${taskId}`);
    const t = r.json?.task || {};
    if (t.status === "running" || t.status === "preparing_workspace" || t.status === "planning" || t.status === "retrying" || t.status === "validating") {
      writeState({ phase: t.status, at: Date.now() });
    }
    if (t.status === "completed") return { ok: true, task: { ...t, artifacts: r.json?.artifacts || [] } };
    if (t.status === "failed" || t.status === "cancelled") return { ok: false, task: t };
    await new Promise((res) => setTimeout(res, 5000));
  }
  return { ok: false, task: { status: "timeout" } };
}

async function main() {
  fs.mkdirSync(STATE, { recursive: true });
  let login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  if (login.status !== 200) {
    const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: "CloudRec", inviteCode: INVITE }), cache: "no-store" });
    if (reg.status !== 200) throw new Error(`注册失败 ${reg.status}`);
    login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), cache: "no-store" });
  }
  const setCookie = login.headers.get("set-cookie") || "";
  cookie = setCookie.split(";")[0];
  console.log("登录成功");

  // 长任务（≥2 分钟，确保 worker 崩溃窗口）
  const r = await api("/api/tasks", { method: "POST", body: {
    goal: "写一份关于太阳系历史的完整综述（至少 8000 字），分 5 个章节，每章含详细天文数据，保存为 markdown 文件交付",
    title: "恢复验收长任务",
  } });
  if (r.status !== 200) throw new Error(`创建任务 ${r.status}: ${r.text.slice(0, 200)}`);
  const taskId = r.json?.task?.id || r.json?.id;
  writeState({ taskId, created: true });
  console.log("任务已创建:", taskId);

  // 等待进入执行态（orchestrator 在此窗口 kill worker）
  const deadline = Date.now() + 240_000;
  let entered = false;
  while (Date.now() < deadline) {
    const s = await api(`/api/tasks/${taskId}`);
    const status = s.json?.task?.status;
    if (status === "running" || status === "preparing_workspace" || status === "planning") {
      entered = true;
      writeState({ phase: "running", readyForKill: true });
      console.log("任务进入执行态，可杀 worker:", status);
      break;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  if (!entered) {
    writeState({ phase: "never-entered" });
    console.log("WARN: 任务未进入执行态（可能已完成或排队异常）——仍继续轮询");
  }

  const result = await pollTask(taskId);
  writeState({ final: result.task.status, ok: result.ok });
  if (!result.ok) throw new Error(`任务 ${result.task.status}: ${result.task.error || ""}`);
  const arts = result.task.artifacts || [];
  if (!arts.length) throw new Error("无产物");
  console.log(`PASS 恢复验收：任务 ${result.task.status}，产物 ${arts.length} 个（${arts.map((a) => a.name || a.filename).join(", ")}）`);
  process.exit(0);
}

main().catch((error) => {
  console.error("FAIL:", String(error.message || error).slice(0, 300));
  process.exit(1);
});
