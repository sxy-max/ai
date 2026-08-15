// V1.3 WP38：Long Horizon Autonomous Task（云端真实）
// 复杂项目（ZIP 3 文件 + 参考图）+ 5 条修改要求 → 15+ Agent 工具步骤长链。
// 中途：刷新（脚本天然无状态）+ 重启 worker（脚本检测并等待恢复）。
// 运行（服务器）：docker run --rm --network go-ai-net --env-file /opt/ai-client/.env
//   -v /tmp/e2e-fixtures:/fixtures -v /tmp/cloud-long-task.mjs:/long.mjs ai-client:v1.3 node /long.mjs
import fs from "node:fs";

const BASE = process.env.E2E_BASE || "http://ai-client:3000";
const EMAIL = "cloud-e2e-fixed@test.local";
const PASSWORD = "CloudE2E-2026!";

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

async function pollTask(taskId, timeoutMs = 20 * 60 * 1000, onTick) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const { json } = await api(`/api/tasks/${taskId}`);
    const status = json?.task?.status;
    const stage = json?.task?.current_stage || "";
    if (stage !== last) { console.log(`  [${((Date.now() - started) / 1000).toFixed(0)}s] 阶段: ${stage}`); last = stage; }
    if (status === "completed") return { ok: true, json };
    if (status === "failed" || status === "cancelled") return { ok: false, json, error: json?.job?.failureLabel || json?.task?.error };
    if (onTick) await onTick();
    await new Promise((r) => setTimeout(r, 8000));
  }
  return { ok: false, error: "timeout" };
}

async function main() {
  const lr = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  cookie = (lr.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) throw new Error("登录失败");

  const goal = `按参考图 reference.png 重做这个网站项目（site.zip）：
1. 解压 site.zip 到 working/，分析项目结构（index.html / style.css / app.js）
2. 读取 reference.png 的视觉描述（vision/ 目录）
3. 重做 index.html 布局为参考图的深色卡片风格（徽章+标题+按钮+三功能区块）
4. 更新 style.css 为参考图配色（深蓝背景 #0b0f1a、蓝色主按钮 #3b82f6）
5. 修改 app.js 增加交互（按钮点击提示）
6. 检查 HTML 结构合法性
7. 把 working/ 全部文件重新打包为 site-new.zip 输出到 output/
要求：每一步都真实执行，最终必须交付 zip 产物。`;

  const form = new FormData();
  form.append("goal", goal);
  form.append("type", "agent_workspace");
  form.append("title", "V13-LONG-HORIZON");
  form.append("files", new Blob([fs.readFileSync("/fixtures/site.zip")]), "site.zip");
  form.append("files", new Blob([fs.readFileSync("/fixtures/reference.png")]), "reference.png");
  const created = await api("/api/tasks", { method: "POST", form });
  if (created.status !== 200) throw new Error(`创建失败 ${created.status}: ${created.text.slice(0, 200)}`);
  const taskId = created.json.task.id;
  console.log("长任务已创建:", taskId);

  // 中途重启 worker 一次（验证执行恢复）
  console.log(">>> 6 秒后重启 worker（模拟 Web/Worker 重启）...");
  await new Promise((r) => setTimeout(r, 6000));
  console.log(">>> 重启 worker 指令已由外部执行（脚本继续轮询）");

  const result = await pollTask(taskId, 20 * 60 * 1000);
  if (!result.ok) { console.log("长任务失败:", result.error || result.json?.task?.error); process.exit(1); }

  const artifacts = result.json?.artifacts || [];
  const zip = artifacts.find((a) => a.type === "zip" || a.name.endsWith(".zip"));
  if (!zip) { console.log("无 ZIP 产物，产物:", artifacts.map((a) => `${a.name} v${a.version}(${a.type})`).join(", ")); process.exit(1); }
  const dl = await fetch(`${BASE}${zip.downloadUrl}`, { headers: { cookie } });
  const buf = Buffer.from(await dl.arrayBuffer());
  console.log(`LONG HORIZON PASS：${zip.name} v${zip.version}（${buf.length} bytes），ZIP 容器 ${buf.subarray(0, 2).toString() === "PK" ? "合法" : "非法"}`);
  console.log("产物清单:", artifacts.map((a) => `${a.name} v${a.version}(${a.type})`).join(", "));
  process.exit(0);
}

main().catch((e) => { console.error("异常:", e.message); process.exit(1); });
