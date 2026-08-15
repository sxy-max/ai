/** Browser Runtime 测试（V1.4 WP19-21/53）：安全策略 + 真实 chromium 会话 + 崩溃恢复。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateBrowserUrl, sanitizeDownloadName, NavigationBudget, resolveSecurityPolicy } from "../../lib/browser/security";
import { BrowserSession, BrowserRuntime } from "../../lib/browser/runtime";
import { browserAct, closeBrowserSession } from "../../lib/browser/tools";
import { WorkspaceManager } from "../../lib/workspace/service";
import { ToolExecutionContext } from "../../lib/tools/registry";

// ---------- 安全层（纯函数） ----------

test("URL 协议白名单：http/https 放行，file/javascript/data 拒绝", () => {
  assert.equal(validateBrowserUrl("https://example.com/a?b=1"), null);
  assert.equal(validateBrowserUrl("http://127.0.0.1:8080/x"), null);
  assert.match(validateBrowserUrl("file:///etc/passwd") || "", /file/);
  assert.match(validateBrowserUrl("javascript:alert(1)") || "", /javascript/);
  assert.match(validateBrowserUrl("data:text/html,<h1>x</h1>") || "", /data/);
  assert.match(validateBrowserUrl("not a url") || "", /无效/);
});

test("下载文件名净化：去路径、去危险字符", () => {
  assert.equal(sanitizeDownloadName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeDownloadName("报告 v2.pdf"), "报告 v2.pdf");
  assert.equal(sanitizeDownloadName("a:b*.c"), "a_b_.c");
});

test("导航预算：限额内通过，超限拒绝", () => {
  const budget = new NavigationBudget(3);
  assert.equal(budget.exhausted, false);
  budget.spend(); budget.spend();
  assert.equal(budget.remaining, 1);
  budget.spend();
  assert.equal(budget.exhausted, true);
});

test("安全策略默认值与覆盖", () => {
  const p = resolveSecurityPolicy();
  assert.equal(p.maxNavigations, 30);
  assert.equal(p.maxDownloadBytes, 20 * 1024 * 1024);
  const q = resolveSecurityPolicy({ downloadsDir: "/x", maxNavigations: 5 });
  assert.equal(q.downloadsDir, "/x");
  assert.equal(q.maxNavigations, 5);
});

// ---------- 真实 chromium 集成 ----------

function serveHtml(html: string): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        stop: async () => {
          // 浏览器 keep-alive 连接会阻塞 server.close 回调，必须强制断开
          server.closeAllConnections();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

const PAGE = `<!doctype html><html><head><title>测试页</title></head><body>
  <h1>欢迎来到测试页</h1>
  <p>这里有一段可见文字。</p>
  <a href="/about">关于我们</a>
  <button onclick="document.title='clicked'">点我</button>
  <input placeholder="输入框" />
  <div style="height:2000px"></div>
</body></html>`;

test("browser.navigate + read_page：观察模型（标题/文本/元素）", async () => {
  const { port, stop } = await serveHtml(PAGE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-test-"));
  const ws = new WorkspaceManager(dir);
  ws.createWorkspace();
  const ctx: ToolExecutionContext = { taskId: "t", userId: "u", workspace: ws };
  try {
    const r = await browserAct({ action: "navigate", url: `http://127.0.0.1:${port}/` }, ctx);
    assert.equal(r.ok, true, String(r.error));
    const obs = JSON.parse(String(r.output));
    assert.equal(obs.url, `http://127.0.0.1:${port}/`);
    assert.equal(obs.title, "测试页");
    assert.match(obs.visibleText, /欢迎来到测试页/);
    assert.match(obs.visibleText, /可见文字/);
    const links = obs.interactiveElements.filter((e: { tag: string }) => e.tag === "a");
    assert.ok(links.some((e: { href?: string }) => e.href === `http://127.0.0.1:${port}/about`), "链接应补全为绝对 URL");
    assert.ok(obs.interactiveElements.some((e: { tag: string }) => e.tag === "button"));
    assert.ok(obs.interactiveElements.some((e: { tag: string }) => e.tag === "input"));
    // 可见文本有上限
    assert.ok(obs.visibleText.length <= 8_000);
  } finally {
    closeBrowserSession(dir);
    await stop();
  }
});

test("browser.click / browser.type / browser.screenshot 闭环", async () => {
  const { port, stop } = await serveHtml(PAGE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-test-"));
  const ws = new WorkspaceManager(dir);
  ws.createWorkspace();
  const ctx: ToolExecutionContext = { taskId: "t", userId: "u", workspace: ws };
  try {
    assert.ok((await browserAct({ action: "navigate", url: `http://127.0.0.1:${port}/` }, ctx)).ok);
    const click = await browserAct({ action: "click", selector: "button" }, ctx);
    assert.equal(click.ok, true, String(click.error));
    const type = await browserAct({ action: "type", selector: "input", text: "hello" }, ctx);
    assert.equal(type.ok, true, String(type.error));
    const shot = await browserAct({ action: "screenshot" }, ctx);
    assert.equal(shot.ok, true, String(shot.error));
    const obs = JSON.parse(String(shot.output));
    assert.match(obs.screenshot || "", /^browser-screenshots\//);
    const shotPath = path.join(dir, String(obs.screenshot));
    assert.ok(fs.existsSync(shotPath), "截图应写入 workspace/browser-screenshots/");
    assert.ok(fs.statSync(shotPath).size > 100, "截图应为真实 PNG");
    // 下载当前页（html 内容）
    const dl = await browserAct({ action: "download", url: `http://127.0.0.1:${port}/` }, ctx);
    assert.equal(dl.ok, true, String(dl.error));
    const dlFiles = fs.readdirSync(path.join(dir, "browser-downloads"));
    assert.ok(dlFiles.length >= 1, "下载应写入 workspace/browser-downloads");
  } finally {
    closeBrowserSession(dir);
    await stop();
  }
});

test("browser 崩溃恢复：关闭浏览器后下一次调用自动重启（WP53）", async () => {
  const { port, stop } = await serveHtml(PAGE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-test-"));
  const ws = new WorkspaceManager(dir);
  ws.createWorkspace();
  const ctx: ToolExecutionContext = { taskId: "t", userId: "u", workspace: ws };
  try {
    assert.ok((await browserAct({ action: "navigate", url: `http://127.0.0.1:${port}/` }, ctx)).ok);
    // 模拟浏览器进程死亡：直接关掉底层会话
    const { browserRuntimeFor } = await import("../../lib/browser/tools");
    const rt = browserRuntimeFor(dir);
    await rt.shutdown();
    // 下一次调用应自动重启并成功
    const again = await browserAct({ action: "read_page" }, ctx);
    assert.equal(again.ok, true, String(again.error));
    const obs = JSON.parse(String(again.output));
    assert.match(obs.title, /测试页/);
  } finally {
    closeBrowserSession(dir);
    await stop();
  }
});

test("浏览器可用性探测 + 导航限额", async () => {
  const { port, stop } = await serveHtml(PAGE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-test-"));
  const ws = new WorkspaceManager(dir);
  ws.createWorkspace();
  const ctx: ToolExecutionContext = { taskId: "t", userId: "u", workspace: ws };
  try {
    const session = new BrowserSession({ downloadsDir: path.join(dir, "browser-downloads") });
    await session.launch();
    assert.equal(session.isReady, true);
    const obs = await session.act({ action: "navigate", url: `http://127.0.0.1:${port}/` });
    // 导航计 1 次预算；read_page 不耗预算
    assert.equal(session.budget.remaining, 29);
    assert.equal(obs.navigationCount, 29);
    await session.close();
    assert.equal(session.isReady, false);
  } finally {
    await stop();
  }
});
