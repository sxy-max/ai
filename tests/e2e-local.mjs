// WP11 本地真实 E2E 矩阵（需本地 dev server + task-worker + PG + Redis 运行中）
// 覆盖：T1(mock聊天) T3(PPTX) T4(HTML) T5(CSV内容) T11(失败) T12(worker崩溃恢复) T13(Redis降级)
// 用法：node tests/e2e-local.mjs <baseUrl>
import { execSync } from 'node:child_process';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const results = [];

function report(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' | ' + detail : ''}`);
}

async function createTask(goal, type = 'artifact') {
  const res = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal, type })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'create failed');
  return body.task;
}

async function waitTask(id, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE}/api/tasks/${id}`);
    const d = await res.json();
    if (['completed', 'failed', 'cancelled'].includes(d.task.status)) return d;
    await sleep(800);
  }
  throw new Error('task timeout');
}

// ============ T1: 普通聊天（mock 模型流式，带真实 modelToken）============
try {
  const modelsRes = await fetch(`${BASE}/api/models`);
  const models = await modelsRes.json();
  const mock = (models.models || []).find((m) => m.key === 'mock-code') || (models.models || [])[0];
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-password': process.env.ACCESS_PASSWORD || '' },
    body: JSON.stringify({ provider: mock.provider || 'opencode-go', model: mock.key, modelToken: mock.modelToken || '',
      messages: [{ role: 'user', content: '你好' }] })
  });
  const text = await res.text();
  report('T1 普通聊天（mock 流式）', res.status === 200 && text.includes('done'), `status=${res.status}`);
} catch (e) { report('T1 普通聊天', false, e.message); }

// ============ T3: PPTX 真实生成 ============
try {
  const task = await createTask('根据旋转圆环小珠问题，生成两页 PPT 文件');
  const done = await waitTask(task.id);
  const art = done.artifacts[0];
  const ok = done.task.status === 'completed' && art && art.type === 'pptx';
  let dlOk = false;
  if (ok) {
    const dl = await fetch(`${BASE}${art.downloadUrl}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    dlOk = dl.status === 200 && buf.length > 10000 && buf[0] === 0x50 && buf[1] === 0x4b; // PK zip 魔数
  }
  report('T3 PPTX 真实生成+下载', ok && dlOk, `type=${art?.type} status=${done.task.status}`);
} catch (e) { report('T3 PPTX', false, e.message); }

// ============ T4: HTML 生成 ============
try {
  const task = await createTask('生成一个移动端优先的网页');
  const done = await waitTask(task.id);
  const art = done.artifacts[0];
  const dl = art ? await fetch(`${BASE}${art.downloadUrl}`) : null;
  const buf = dl ? Buffer.from(await dl.arrayBuffer()) : null;
  report('T4 HTML 真实生成', done.task.status === 'completed' && art?.type === 'html' && buf && buf.toString().includes('<html'), `type=${art?.type}`);
} catch (e) { report('T4 HTML', false, e.message); }

// ============ T5: CSV 内容验证 ============
try {
  const task = await createTask('整理销售数据，导出 CSV 文件');
  const done = await waitTask(task.id);
  const art = done.artifacts[0];
  const dl = art ? await fetch(`${BASE}${art.downloadUrl}`) : null;
  const text = dl ? await dl.text() : '';
  report('T5 CSV 内容验证', done.task.status === 'completed' && art?.type === 'csv' && text.length > 0, `type=${art?.type} size=${text.length}`);
} catch (e) { report('T5 CSV', false, e.message); }

// ============ T11: 任务失败（dev 步骤无 runtime → 明确 failed）============
try {
  const task = await createTask('根据图片修改 HTML', 'agent_workspace');
  const done = await waitTask(task.id, 30000);
  const ok = done.task.status === 'failed' && /DEV_RUNTIME_UNAVAILABLE|DEV_RUN_/.test(done.task.error);
  report('T11 任务失败明确化', ok, `status=${done.task.status} error=${(done.task.error || '').slice(0, 60)}`);
} catch (e) { report('T11 任务失败', false, e.message); }

// ============ T13: Redis 降级（停 redis → 任务仍执行 → 事件在 PG）============
try {
  // 停本地 redis 容器
  let redisStopped = false;
  try { execSync('docker stop goai-redis 2>/dev/null || docker stop goai-redis-local 2>/dev/null', { stdio: 'ignore' }); redisStopped = true; } catch {}
  const task = await createTask('整理一份销售数据表格');
  const done = await waitTask(task.id);
  const eventsOk = done.events.length > 0;
  report('T13 Redis 降级（任务+事件仍可用）', done.task.status === 'completed' && eventsOk, `status=${done.task.status} events=${done.events.length}`);
  if (redisStopped) { try { execSync('docker start goai-redis 2>/dev/null || docker start goai-redis-local 2>/dev/null', { stdio: 'ignore' }); } catch {} }
} catch (e) { report('T13 Redis 降级', false, e.message); }

// ============ T12: worker 崩溃恢复（孤儿任务 → 回收 → 完成）============
try {
  const { Client } = await import('pg');
  const task = await createTask('整理一份销售数据表格');
  const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgres://goai:goai@127.0.0.1:5432/go_ai' });
  await client.connect();
  await client.query(`UPDATE tasks SET status = 'running', worker_id = 'crashed', lease_expires = now() - interval '1 second' WHERE id = $1`, [task.id]);
  await client.end();
  const done = await waitTask(task.id, 60000);
  report('T12 worker 崩溃恢复', done.task.status === 'completed' && done.artifacts.length > 0,
    `status=${done.task.status} artifacts=${done.artifacts.length}`);
} catch (e) { report('T12 worker 崩溃恢复', false, e.message); }

console.log(`\n=== 本地 E2E：${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
