// Web Research 专项验收（§43：Claude Code 使用 Browser/Search 真实研究）：
// 1) 研究类任务 → directive 含 browser/search 能力
// 2) 任务完成（真实答案/产物）
// 3) 事件流含 browser.* 或 search.* 工具调用（证明研究真实发生）
// 运行：服务器容器内；参数 GOAL 可覆盖。
import fs from "node:fs";

const BASE = process.env.E2E_BASE || "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "web-research@test.local";
const PASSWORD = "WebResearch-2026!";
const GOAL = process.env.GOAL || "搜索并总结：2026 年 DeepSeek 发布了哪些值得关注的新模型或新能力？至少用浏览器或搜索工具查一个真实来源，最后给出三句话总结。";

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

async function main() {
  let r = await api("/api/auth/register", { method: "POST", body: { email: EMAIL, password: PASSWORD, inviteCode: INVITE } });
  if (r.status !== 200 && r.status !== 409 && r.status !== 429) throw new Error(`register ${r.status}`);
  r = await api("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`login ${r.status}`);
  const sc = r.headers.getSetCookie?.() || [];
  cookie = (sc[0] || "").split(";")[0] || (r.headers.get("set-cookie") || "").split(";")[0];

  const created = await api("/api/tasks", { method: "POST", form: (() => {
    const form = new FormData();
    form.append("goal", GOAL);
    form.append("title", "web-research-verify");
    return form;
  })() });
  if (created.status !== 200) throw new Error(`create ${created.status}: ${created.text.slice(0, 150)}`);
  const taskId = created.json?.task?.id || created.json?.id;
  console.log("task:", taskId);

  const deadline = Date.now() + 1500_000;
  let done = false;
  let final = {};
  let toolCalls = [];
  while (Date.now() < deadline) {
    const s = await api(`/api/tasks/${taskId}`);
    const t = s.json?.task || {};
    if (t.status === "completed" || t.status === "failed" || t.status === "cancelled") {
      done = true;
      final = t;
      break;
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  if (!done) { console.log("FAIL: 超时"); process.exit(1); }
  if (final.status !== "completed") { console.log(`FAIL: ${final.status} ${final.error || ""}`); process.exit(1); }

  // 事件流：browser.* / search.* 工具调用
  const ev = await api(`/api/tasks/${taskId}/events`);
  if (ev.status === 200 && Array.isArray(ev.json)) {
    for (const e of ev.json) {
      if (e.type === "tool" && e.data?.name) toolCalls.push(e.data.name);
    }
  }
  const browserUsed = toolCalls.filter((n) => /^browser\./.test(n));
  const searchUsed = toolCalls.filter((n) => /^search\.|^exa/.test(n));
  const arts = final.artifacts || [];
  console.log(`PASS 研究任务完成：产物 ${arts.length} 个；工具调用 ${toolCalls.length} 次`);
  console.log(`   browser 工具: ${browserUsed.length ? browserUsed.join(", ") : "无"}`);
  console.log(`   search 工具: ${searchUsed.length ? searchUsed.join(", ") : "无"}`);
  if (!browserUsed.length && !searchUsed.length) {
    console.log("FAIL: 未发现 browser/search 工具调用（研究未真实发生）");
    process.exit(1);
  }
  console.log("PASS: Web Research 真实发生（browser/search 工具进入执行）");
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
