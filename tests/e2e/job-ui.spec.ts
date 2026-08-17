// E2E: 任务系统流程（V1.1 续接轮更新）
// 产品已从 v7「聊天页内联 JobCard」迁移到「/api/tasks → 任务详情页」（PRD §63/§82）。
// 本文件守护新流程：聊天页文件任务 → 详情页渲染（hooks 崩溃回归）、404 错误路径。
// 任务在 E2E 环境停留在 queued（无 worker），断言不依赖完成态。
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/chat");
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 20_000 });
  await page.locator(".model-wrap select").selectOption("mock-lifecycle", { timeout: 15_000 });
});

test("TEST16 文件任务：创建 → 跳转任务详情页（状态/事件流/步骤 Tab/取消）", async ({ page }) => {
  await page.locator('.composer input[type="file"]').setInputFiles({ name: "note.md", mimeType: "text/markdown", buffer: Buffer.from("# 说明") });
  await page.locator('[data-testid="chat-input"]').fill("帮我整理这个文件并返回 markdown");
  await page.locator('[data-testid="chat-input"]').press("Enter");

  // 新流程：POST /api/tasks → 详情页（回归守护：TaskDetailPage hooks 顺序 bug 曾致整页崩溃）
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}/, { timeout: 15_000 });
  // 详情页正常渲染
  await expect(page.locator("body")).toContainText("排队中", { timeout: 15_000 });
  await expect(page.locator("body")).toContainText("task · created");
  await expect(page.locator("body")).toContainText("任务已创建");
  // 结果优先：默认打开「结果」面板；「过程」= 用户可理解的执行阶段
  await expect(page.locator("body")).toContainText("结果");
  await expect(page.locator("body")).toContainText("过程");
  // queued 任务可取消
  await expect(page.getByRole("button", { name: "取消" })).toBeVisible();
  // 页面未崩溃（error boundary 不出现）
  await expect(page.locator("body")).not.toContainText("This page couldn");
});

test("TEST17 任务详情 404：显示错误而非崩溃", async ({ page }) => {
  await page.goto("/tasks/00000000-0000-0000-0000-000000000000");
  await expect(page.locator("body")).toContainText("任务不存在或已删除", { timeout: 15_000 });
  await expect(page.locator("body")).not.toContainText("This page couldn");
});
