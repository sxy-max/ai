# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: message-lifecycle.spec.ts >> TEST5 assistant KaTeX
- Location: tests\e2e\message-lifecycle.spec.ts:55:5

# Error details

```
Error: locator.selectOption: Target crashed 
Call log:
  - waiting for locator('.model-wrap select')

```

# Test source

```ts
  1  | // E2E: Message Lifecycle + mock 模型(不消耗真实额度)
  2  | import { test, expect } from "@playwright/test";
  3  | 
  4  | async function sendPrompt(page: any, prompt: string) {
  5  |   await page.locator('[data-testid="chat-input"]').fill(prompt);
  6  |   await page.locator('[data-testid="chat-input"]').press("Enter");
  7  | }
  8  | 
  9  | async function selectModel(page: any, model: string) {
  10 |   await page.locator(".model-wrap select").selectOption({ label: model }).catch(async () => {
> 11 |     await page.locator(".model-wrap select").selectOption(model);
     |                                              ^ Error: locator.selectOption: Target crashed 
  12 |   });
  13 | }
  14 | 
  15 | test.beforeEach(async ({ page }) => {
  16 |   await page.goto("/");
  17 |   await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 20_000 });
  18 | });
  19 | 
  20 | test("TEST1 reasoning + final", async ({ page }) => {
  21 |   await selectModel(page, "mock-reasoning-final");
  22 |   await sendPrompt(page, "物理题");
  23 |   await expect(page.locator(".reasoning")).toBeVisible({ timeout: 20_000 });
  24 |   await expect(page.locator(".reasoning").getByText("推理内容")).toBeVisible();
  25 |   await expect(page.locator(".msg-parts.assistant .msg-text")).toContainText("最终回答");
  26 |   await expect(page.locator("body")).not.toContainText("Empty messages are not allowed");
  27 | });
  28 | 
  29 | test("TEST2 reasoning-only → 重试提示 + 下一轮正常", async ({ page }) => {
  30 |   await selectModel(page, "mock-reasoning-only");
  31 |   await sendPrompt(page, "只推理不回答");
  32 |   await expect(page.locator(".msg-parts.assistant .msg-text")).toContainText("模型完成了推理，但没有返回最终回答", { timeout: 20_000 });
  33 |   // 下一轮正常
  34 |   await selectModel(page, "mock-lifecycle");
  35 |   await sendPrompt(page, "你好");
  36 |   await expect(page.locator(".msg-parts.assistant .msg-text").last()).toContainText("你好", { timeout: 20_000 });
  37 |   await expect(page.locator("body")).not.toContainText("Empty messages are not allowed");
  38 | });
  39 | 
  40 | test("TEST3 连续第二轮", async ({ page }) => {
  41 |   await selectModel(page, "mock-reasoning-final");
  42 |   await sendPrompt(page, "第一轮问题");
  43 |   await expect(page.locator(".msg-parts.assistant .msg-text").last()).toContainText("最终回答", { timeout: 20_000 });
  44 |   await sendPrompt(page, "把上面的答案压缩成三句话");
  45 |   await expect(page.locator(".msg-parts.assistant .msg-text").last()).toContainText("你好", { timeout: 20_000 });
  46 |   await expect(page.locator("body")).not.toContainText("Empty messages are not allowed");
  47 | });
  48 | 
  49 | test("TEST4 user KaTeX", async ({ page }) => {
  50 |   await sendPrompt(page, "一个质量为 \\(m\\) 的小珠沿半径为 \\(R\\) 的圆环运动，角速度为 \\(\\omega\\)。");
  51 |   await expect(page.locator(".msg-parts.user .msg-text .katex").first()).toBeVisible({ timeout: 20_000 });
  52 |   await expect(page.locator(".msg-parts.user .msg-text")).not.toContainText("\\(");
  53 | });
  54 | 
  55 | test("TEST5 assistant KaTeX", async ({ page }) => {
  56 |   await selectModel(page, "mock-katex");
  57 |   await sendPrompt(page, "输出公式");
  58 |   await expect(page.locator(".msg-parts.assistant .msg-text .katex-display")).toBeVisible({ timeout: 20_000 });
  59 |   await expect(page.locator(".msg-parts.assistant .msg-text")).not.toContainText("\\Omega=");
  60 | });
  61 | 
  62 | test("TEST6 HTML>100 → artifact", async ({ page }) => {
  63 |   await selectModel(page, "mock-html-150");
  64 |   await sendPrompt(page, "生成 150 行 HTML");
  65 |   await expect(page.locator('[data-testid="artifact-card"]').first()).toBeVisible({ timeout: 30_000 });
  66 |   await expect(page.locator(".msg-parts.assistant .msg-text")).toContainText("HTML 已生成");
  67 |   await expect(page.locator(".msg-parts.assistant .msg-text")).not.toContainText("line149");
  68 |   const stored = await page.evaluate(() => localStorage.getItem("go-ai-conversations-v3") || "");
  69 |   expect(stored.includes("line149")).toBe(false);
  70 | });
  71 | 
  72 | test("TEST7 刷新历史后 HTML 不回退", async ({ page }) => {
  73 |   await selectModel(page, "mock-html-150");
  74 |   await sendPrompt(page, "生成 150 行 HTML");
  75 |   await expect(page.locator('[data-testid="artifact-card"]').first()).toBeVisible({ timeout: 30_000 });
  76 |   await page.reload();
  77 |   await expect(page.locator('[data-testid="artifact-card"]').first()).toBeVisible({ timeout: 20_000 });
  78 |   await expect(page.locator(".msg-parts.assistant .msg-text")).not.toContainText("line149");
  79 | });
  80 | 
```