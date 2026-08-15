/** SandboxManager + Local/Docker Provider 测试（V1.3 WP4-5）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SandboxManager } from "../../lib/sandbox/manager";
import { LocalSandboxProvider } from "../../lib/sandbox/localProvider";
import { DockerSandboxProvider } from "../../lib/sandbox/dockerProvider";

const dockerAvailable = process.env.SANDBOX_TEST_DOCKER !== "0";

function tempWorkspace(tag: string): string {
  const dir = path.join(os.tmpdir(), `goai-sbx-${tag}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "input"), { recursive: true });
  fs.writeFileSync(path.join(dir, "input", "note.md"), "# 测试\n\n内容\n");
  return dir;
}

test("Local provider：exec/read/write/list/snapshot/restore 全流程", async () => {
  const ws = tempWorkspace("local");
  const manager = new SandboxManager(new LocalSandboxProvider());
  const sbx = "local-test";

  const alloc = await manager.allocate(sbx, ws);
  assert.equal(alloc.ok, true);

  const exec = await manager.exec(sbx, ws, ["node", "-e", "console.log('hello-sbx')"]);
  assert.equal(exec.ok, true);
  assert.match(exec.stdout, /hello-sbx/);

  await manager.writeFile(sbx, ws, "working/out.txt", Buffer.from("写入内容", "utf8"));
  const read = await manager.readFile(sbx, ws, "working/out.txt");
  assert.equal(read.ok, true);
  assert.equal(read.content?.toString("utf8"), "写入内容");

  const list = await manager.listFiles(sbx, ws, "input");
  assert.equal(list.ok, true);
  assert.ok(list.files?.some((f) => f.path.endsWith("note.md")));

  const snap = await manager.snapshot(sbx, ws);
  assert.equal(snap.ok, true);
  assert.ok(snap.snapshotId);

  // 修改后 restore 还原
  await manager.writeFile(sbx, ws, "working/out.txt", Buffer.from("被改坏", "utf8"));
  const restored = await manager.restore(sbx, ws, snap.snapshotId!);
  assert.equal(restored.ok, true);
  const after = await manager.readFile(sbx, ws, "working/out.txt");
  assert.equal(after.content?.toString("utf8"), "写入内容", "restore 应还原快照内容");

  await manager.cleanup(sbx, ws);
});

test("Local provider：路径逃逸被拒 + 超限文件被拒", async () => {
  const ws = tempWorkspace("local-sec");
  const manager = new SandboxManager(new LocalSandboxProvider());
  const sbx = "local-sec";

  const escape = await manager.writeFile(sbx, ws, "../../escape.txt", Buffer.from("x"));
  assert.equal(escape.ok, false);
  assert.match(String(escape.error), /PATH_ESCAPE/);

  const big = await manager.writeFile(sbx, ws, "working/big.bin", Buffer.alloc(60 * 1024 * 1024));
  assert.equal(big.ok, false);
  assert.match(String(big.error), /file_too_large/);
});

test("Docker provider：受限容器 alloc→exec→read/write→terminate", { skip: !dockerAvailable }, async () => {
  const ws = tempWorkspace("docker");
  const provider = new DockerSandboxProvider();
  const health = await provider.health();
  if (!health.ok) {
    console.log("docker 不可用，跳过:", health.detail);
    return;
  }
  const manager = new SandboxManager(provider);
  const sbx = `docker-test-${Date.now()}`;

  const alloc = await manager.allocate(sbx, ws);
  assert.equal(alloc.ok, true, alloc.error);

  const exec = await manager.exec(sbx, ws, ["node", "-e", "console.log(process.version)"]);
  assert.equal(exec.ok, true, exec.stderr);
  assert.match(exec.stdout, /v\d+/);

  await manager.writeFile(sbx, ws, "working/x.txt", Buffer.from("docker-write"));
  const read = await manager.readFile(sbx, ws, "working/x.txt");
  assert.equal(read.content?.toString("utf8"), "docker-write");

  // 超时命令被终止
  const slow = await manager.exec(sbx, ws, ["node", "-e", "setTimeout(()=>{}, 60000)"], { timeoutMs: 2000 });
  assert.equal(slow.timedOut, true);

  await manager.terminate(sbx, ws);
  await manager.cleanup(sbx, ws);
});

test("Docker provider：non-root 容器内无法访问宿主敏感路径", { skip: !dockerAvailable }, async () => {
  const ws = tempWorkspace("docker-sec");
  const manager = new SandboxManager(new DockerSandboxProvider());
  const sbx = `docker-sec-${Date.now()}`;
  const alloc = await manager.allocate(sbx, ws);
  assert.equal(alloc.ok, true);

  // 容器内 /etc/passwd 可读（镜像内）但宿主的 /opt/ai-client/.env 不可见（未挂载）
  const hostEnv = await manager.exec(sbx, ws, ["sh", "-c", "test -f /opt/ai-client/.env && echo FOUND || echo NOT-FOUND"]);
  assert.match(hostEnv.stdout, /NOT-FOUND/, "宿主 .env 不应可见");
  const hostRoot = await manager.exec(sbx, ws, ["sh", "-c", "test -d /data/workspaces && echo FOUND || echo NOT-FOUND"]);
  assert.match(hostRoot.stdout, /NOT-FOUND/, "宿主 workspace 根不应可见");

  await manager.terminate(sbx, ws);
  await manager.cleanup(sbx, ws);
});
