// E2E: Job Event UI —— 文件任务的 8 段状态流转 + artifact 卡片
// 走真实 /api/agent/task（E2E_MODE 下由路由内 mock 分支流式回放 JobEvent），
// 仅拦截 /api/files/upload 以避免 Windows 上创建 /data/workspaces。
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 20_000 });
  await page.locator(".model-wrap select").selectOption("mock-lifecycle", { timeout: 15_000 });
});

test("TEST16 文件任务：JobCard 8 段状态流转 + artifact 卡", async ({ page }) => {
  await page.route("**/api/files/upload*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ files: [], conversationId: "e2e", jobId: "job1" }),
    })
  );

  await page.locator('.composer input[type="file"]').setInputFiles({ name: "note.md", mimeType: "text/markdown", buffer: Buffer.from("# 说明") });
  await page.locator('[data-testid="chat-input"]').fill("E2E_MOCK_FLOW_OK 改这个页面");
  await page.locator('[data-testid="chat-input"]').press("Enter");

  await expect(page.locator('[data-testid="job-card"]')).toBeVisible({ timeout: 15_000 });
  // 中间态：读取文件 → 修改文件 → 生成产物（mock 每事件 500ms，逐段捕获）
  await page.waitForFunction(() => document.querySelector(".job-badge")?.textContent?.includes("读取文件"), null, { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector(".job-badge")?.textContent?.includes("修改文件"), null, { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector(".job-badge")?.textContent?.includes("生成产物"), null, { timeout: 15_000 });
  // 终态 + artifact 卡
  await expect(page.locator(".job-badge")).toContainText("已完成", { timeout: 15_000 });
  const card = page.locator('[data-testid="artifact-card"]').first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("report.md");
});

test("TEST17 文件任务失败：错误信息 + 保留 partial artifact", async ({ page }) => {
  await page.route("**/api/files/upload*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ files: [], conversationId: "e2e", jobId: "job2" }) })
  );

  await page.locator('.composer input[type="file"]').setInputFiles({ name: "note.md", mimeType: "text/markdown", buffer: Buffer.from("# 说明") });
  await page.locator('[data-testid="chat-input"]').fill("E2E_MOCK_FLOW_FAIL 改这个页面");
  await page.locator('[data-testid="chat-input"]').press("Enter");

  await expect(page.locator('[data-testid="job-card"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".job-badge")).toContainText("处理失败", { timeout: 15_000 });
  await expect(page.locator(".job-error-text")).toContainText("沙箱执行超时", { timeout: 15_000 });
  // partial artifact 保留
  const card = page.locator('[data-testid="artifact-card"]').first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("partial.md");
});
