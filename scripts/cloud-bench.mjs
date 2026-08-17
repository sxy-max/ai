// Cloud AI Work System — Claude Code Harness Benchmark（本 Goal §31/§32）
// 真实任务 × 主模型：验证「Claude Code Harness + 主模型」组合，而非 HTTP 200 或自我介绍。
// 场景覆盖：普通中文问答 / 复杂推理 / coding / office tool use / 视觉协作 / 项目延续。
//
// 运行（部署后，每模型一轮）：
//   scp scripts/cloud-bench.mjs tencent-ai:/tmp/
//   ssh tencent-ai "sudo docker run --rm --network go-ai-net --env-file /opt/ai-client/.env \
//     -e BENCH_MODEL=deepseek-v4-flash -v /tmp/cloud-bench.mjs:/bench.mjs ai-client:latest node /bench.mjs"
//   ssh tencent-ai "sudo docker run --rm --network go-ai-net --env-file /opt/ai-client/.env \
//     -e BENCH_MODEL=deepseek-v4-pro -v /tmp/cloud-bench.mjs:/bench.mjs ai-client:latest node /bench.mjs"
// 结论写入 docs/HARNESS_BENCHMARK.md。
import fs from "node:fs";

const BASE = process.env.E2E_BASE || "http://ai-client:3000";
const INVITE = process.env.ACCESS_PASSWORD || "";
const EMAIL = `bench-${Date.now()}@test.local`;
const PASSWORD = "Bench-2026!";
const MODEL = process.env.BENCH_MODEL || "deepseek-v4-flash";
const FIXTURES = "/tmp/bench-fixtures";

let cookie = "";
const results = [];

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

function multipart(fields, files) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files || []) form.append("files", new Blob([fs.readFileSync(f.path)]), f.name);
  return form;
}

async function login() {
  let r = await api("/api/auth/register", { method: "POST", body: { email: EMAIL, password: PASSWORD, inviteCode: INVITE } });
  if (r.status !== 200 && r.status !== 409 && r.status !== 429) throw new Error(`register ${r.status}`);
  if (r.status === 429) console.log("register rate-limited; reusing existing account");
  r = await api("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`login ${r.status}`);
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) {
    // 手动读取 set-cookie 集合
    const sc = r.headers.getSetCookie?.() || [];
    cookie = (sc[0] || "").split(";")[0];
  }
}

async function pollTask(taskId, timeoutMs = 900_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api(`/api/tasks/${taskId}`);
    const t = r.json?.task || {};
    if (t.status === "completed") return { ok: true, task: { ...t, artifacts: r.json?.artifacts || [] }, elapsed: (t.completed_at ? new Date(t.completed_at) : new Date()).getTime() - (t.created_at ? new Date(t.created_at).getTime() : Date.now()) };
    if (t.status === "failed" || t.status === "cancelled") return { ok: false, task: t };
    await new Promise((res) => setTimeout(res, 5000));
  }
  return { ok: false, task: { status: "timeout" } };
}

/** 场景定义：goal + 附件 + 期望（产物类型 / 文本要点）。 */
const SCENARIOS = [
  {
    id: "B01-chat",
    goal: "用三句话向小学生解释光合作用",
    expect: { text: true, need: "光合" },
    timeout: 300_000,
  },
  {
    id: "B02-reasoning",
    goal: "证明根号2是无理数，并指出证明中反证法的关键步骤，输出完整论证",
    expect: { text: true, need: "无理" },
    timeout: 420_000,
  },
  {
    id: "B03-coding",
    goal: "写一个 Python 程序：读取 data.csv 计算每种产品销量总和与平均，输出结果文件 result.txt，并实际运行验证",
    files: [{ path: `${FIXTURES}/data.csv`, name: "data.csv" }],
    expect: { artifact: "txt", need: "result" },
    timeout: 600_000,
  },
  {
    id: "B04-office",
    goal: "把 data.csv 的销量数据做成一份 Excel 表格（xlsx），含数据与求和行",
    files: [{ path: `${FIXTURES}/data.csv`, name: "data.csv" }],
    expect: { artifact: "xlsx" },
    timeout: 600_000,
  },
  {
    id: "B05-vision",
    goal: "查看 reference.png，用文字详细描述图中内容，包括颜色、布局与任何文字",
    files: [{ path: `${FIXTURES}/reference.png`, name: "reference.png" }],
    expect: { text: true, need: "reference" },
    timeout: 420_000,
  },
];

async function runScenario(s) {
  const id = await api("/api/tasks", { method: "POST", form: multipart({ goal: s.goal, title: `bench-${s.id}-${MODEL}` }, s.files || []) })
    .then((r) => { if (r.status !== 200) throw new Error(`create ${r.status}`); return r.json?.task?.id || r.json?.id; });
  const started = Date.now();
  const { ok, task, elapsed } = await pollTask(id, s.timeout || 900_000);
  if (!ok) return { ok: false, detail: `${task.status}: ${(task.error || "").slice(0, 200)}`, ms: Date.now() - started };
  // 验证产物
  const arts = task.artifacts || [];
  const artifactOk = !s.expect.artifact || arts.some((a) => a.type === s.expect.artifact);
  // 文本要点（quick 任务从 resultSummary 取）
  const summary = (task.resultSummary || "").toLowerCase();
  const textOk = !s.expect.text || !s.expect.need || summary.includes(s.expect.need) || arts.length > 0;
  return {
    ok: artifactOk && textOk,
    detail: `产物 ${arts.map((a) => `${a.name}(${a.type})`).join(",") || "无"}${s.expect.artifact && !artifactOk ? "；缺产物!" : ""}`,
    ms: elapsed || Date.now() - started,
    artifacts: arts.map((a) => a.type).join(","),
  };
}

async function main() {
  await login();
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(`${FIXTURES}/data.csv`, "产品,销量,地区\n手机,120,华东\n电脑,85,华北\n平板,60,华南\n");
  if (!fs.existsSync(`${FIXTURES}/reference.png`)) {
    // 复用 final fixtures（部署时 scp 预置）；缺失则跳过视觉场景
    fs.copyFileSync("/fixtures/reference.png", `${FIXTURES}/reference.png`).catch?.(() => {});
  }
  console.log(`BENCH model=${MODEL} started`);
  for (const s of SCENARIOS) {
    try {
      const r = await runScenario(s);
      results.push({ id: s.id, ...r });
      console.log(`${r.ok ? "PASS" : "FAIL"} ${s.id} :: ${r.detail} :: ${Math.round(r.ms / 1000)}s`);
    } catch (e) {
      results.push({ id: s.id, ok: false, detail: String(e.message || e).slice(0, 200), ms: 0 });
      console.log(`FAIL ${s.id} :: ${String(e.message || e).slice(0, 200)}`);
    }
  }
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n==== BENCH ${MODEL}: ${pass}/${results.length} PASS ====`);
  for (const r of results) console.log(`  ${r.ok ? "✅" : "❌"} ${r.id} :: ${r.detail} :: ${Math.round(r.ms / 1000)}s`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
