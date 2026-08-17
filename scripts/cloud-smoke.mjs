// v2.2 部署 smoke（2026-08-17 最终部署后）：
// 1) 文本问答经 /api/chat（Claude Code）
// 2) 图片问答经 /api/chat（视觉进入回答）
// 3) 图片任务经 /api/tasks（Blob 无 MIME → 附件修复后应判 image → 视觉问答分类）
import fs from "node:fs";

const BASE = process.env.E2E_BASE || "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = "v22-smoke@test.local";
const PASSWORD = "V22Smoke-2026!";
const FIXTURES = "/fixtures";

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

  // 1. 文本问答（Claude Code /api/chat）
  {
    const ct = await api("/api/models").then((x) => {
      const models = x.json?.models || [];
      console.log("models:", models.map((m) => `${m.model}/${m.provider}/${m.key || ""}/${m.modelToken ? "tok" : "no"}`).join(", "));
      const picked = models.find((m) => (m.model || m.id) === "deepseek-v4-flash") || models[0];
      return { model: picked.id || picked.model, token: picked.modelToken };
    });
    const res = await api("/api/chat", { method: "POST", body: { provider: "opencode-go", model: ct.model, modelToken: ct.token, messages: [{ role: "user", content: "用一句话解释什么是 HTTP" }] } });
    if (res.status !== 200) throw new Error(`chat http ${res.status}: ${res.text.slice(0, 120)}`);
    const lines = res.text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const text = lines.filter((e) => e.type === "text").map((e) => e.value || "").join("");
    if (!text.trim() || !text.includes("HTTP")) throw new Error(`文本问答无有效回答: ${text.slice(0, 80)}`);
    console.log(`PASS 1.文本问答：${text.length} 字符`);
  }

  // 2. 图片问答（/api/chat + 内联图片）
  {
    const ct = await api("/api/models").then((x) => {
      const models = x.json?.models || [];
      console.log("models:", models.map((m) => `${m.model}/${m.provider}/${m.key || ""}/${m.modelToken ? "tok" : "no"}`).join(", "));
      const picked = models.find((m) => (m.model || m.id) === "deepseek-v4-flash") || models[0];
      return { model: picked.id || picked.model, token: picked.modelToken };
    });
    const img = fs.readFileSync(`${FIXTURES}/reference.png`).toString("base64");
    const res = await api("/api/chat", { method: "POST", body: { provider: "opencode-go", model: ct.model, modelToken: ct.token, messages: [{ role: "user", content: "这张图里有什么？描述主要元素、颜色和布局", attachments: [{ kind: "image", name: "reference.png", mime: "image/png", dataUrl: `data:image/png;base64,${img}` }] }] } });
    if (res.status !== 200) throw new Error(`img chat http ${res.status}: ${res.text.slice(0, 120)}`);
    const lines = res.text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const text = lines.filter((e) => e.type === "text").map((e) => e.value || "").join("");
    if (!text.trim()) throw new Error("图片问答无回答");
    console.log(`PASS 2.图片问答：${text.length} 字符（视觉进入回答）`);
  }

  // 3. 图片任务（Blob 无 MIME → 附件修复端到端）
  {
    const created = await api("/api/tasks", { method: "POST", form: (() => {
      const form = new FormData();
      form.append("goal", "查看 reference.png，用文字详细描述图中内容，包括颜色、布局与任何文字");
      form.append("title", "v22-img-kind");
      form.append("files", new Blob([fs.readFileSync(`${FIXTURES}/reference.png`)]), "reference.png"); // 无 type！
      return form;
    })() });
    if (created.status !== 200) throw new Error(`create ${created.status}: ${created.text.slice(0, 120)}`);
    const taskId = created.json?.task?.id || created.json?.id;
    const deadline = Date.now() + 600_000;
    let ok = false;
    while (Date.now() < deadline) {
      const s = await api(`/api/tasks/${taskId}`);
      const t = s.json?.task || {};
      if (t.status === "completed") { ok = true; break; }
      if (t.status === "failed" || t.status === "cancelled") throw new Error(`${t.status}: ${t.error || ""}`);
      await new Promise((res) => setTimeout(res, 5000));
    }
    if (!ok) throw new Error("图片任务超时");
    console.log("PASS 3.图片任务完成（附件 kind 修复生效）");
  }

  console.log("\n==== v2.2 SMOKE 3/3 PASS ====");
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
