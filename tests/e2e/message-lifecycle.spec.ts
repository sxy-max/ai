// E2E: Message Lifecycle + mock 模型(不消耗真实额度)
import { test, expect } from "@playwright/test";

async function sendPrompt(page: any, prompt: string) {
  await page.locator('[data-testid="chat-input"]').fill(prompt);
  await page.locator('[data-testid="chat-input"]').press("Enter");
}

async function selectModel(page: any, model: string) {
  await page.locator(".model-wrap select").selectOption({ label: model }).catch(async () => {
    await page.locator(".model-wrap select").selectOption(model);
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 20_000 });
});

test("TEST1 reasoning + final", async ({ page }) => {
  await selectModel(page, "mock-reasoning-final");
  await sendPrompt(page, "物理题");
  await expect(page.locator(".reasoning")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".reasoning").getByText("推理内容")).toBeVisible();
  await expect(page.locator(".msg-parts.assistant .msg-text")).toContainText("最终回答");
  await expect(page.locator("body")).not.toContainText("Empty messages are not allowed");
});

test("TEST2 reasoning-only → 重试提示 + 下一轮正常", async ({ page }) => {
  await selectModel(page, "mock-reasoning-only");
  await sendPrompt(page, "只推理不回答");
  await expect(page.locator(".msg-parts.assistant .msg-text")).toContainText("模型完成了推理，但没有返回最终回答", { timeout: 20_000 });
  // 下一轮正常
  await selectModel(page, "mock-lifecycle");
  await sendPrompt(page, "你好");
  await expect(page.locator(".msg-parts.assistant .msg-text").last()).toContainText("你好", { timeout: 20_000 });
  await expect(page.locator("body")).not.toContainText("Empty messages are not allowed");
});

test("TEST3 连续第二轮", async ({ page }) => {
  await selectModel(page, "mock-reasoning-final");
  await sendPrompt(page, "第一轮问题");
  await expect(page.locator(".msg-parts.assistant .msg-text").last()).toContainText("最终回答", { timeout: 20_000 });
  await sendPrompt(page, "把上面的答案压缩成三句话");
  await expect(page.locator(".msg-parts.assistant .msg-text").last()).toContainText("你好", { timeout: 20_000 });
  await expect(page.locator("body")).not.toContainText("Empty messages are not allowed");
});

test("TEST4 user KaTeX", async ({ page }) => {
  await sendPrompt(page, "一个质量为 \\(m\\) 的小珠沿半径为 \\(R\\) 的圆环运动，角速度为 \\(\\omega\\)。");
  await expect(page.locator(".msg-parts.user .msg-text .katex").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".msg-parts.user .msg-text")).not.toContainText("\\(");
});

test("TEST5 assistant KaTeX", async ({ page }) => {
  await selectModel(page, "mock-katex");
  await sendPrompt(page, "输出公式");
  await expect(page.locator(".msg-parts.assistant .msg-text .katex-display")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".msg-parts.assistant .msg-text")).not.toContainText("\\Omega=");
});

test("TEST6 HTML>100 → artifact", async ({ page }) => {
  await selectModel(page, "mock-html-150");
  await sendPrompt(page, "生成 150 行 HTML");
  await expect(page.locator('[data-testid="artifact-card"]').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".msg-parts.assistant .msg-text")).toContainText("HTML 已生成");
  await expect(page.locator(".msg-parts.assistant .msg-text")).not.toContainText("line149");
  const stored = await page.evaluate(() => localStorage.getItem("go-ai-conversations-v3") || "");
  expect(stored.includes("line149")).toBe(false);
});

test("TEST7 刷新历史后 HTML 不回退", async ({ page }) => {
  await selectModel(page, "mock-html-150");
  await sendPrompt(page, "生成 150 行 HTML");
  await expect(page.locator('[data-testid="artifact-card"]').first()).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.locator('[data-testid="artifact-card"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".msg-parts.assistant .msg-text")).not.toContainText("line149");
});
