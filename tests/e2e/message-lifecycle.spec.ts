// E2E: Message Lifecycle + mock 模型(不消耗真实额度)
import { test, expect } from "@playwright/test";

async function sendPrompt(page: any, prompt: string) {
  await page.locator('[data-testid="chat-input"]').fill(prompt);
  await page.locator('[data-testid="chat-input"]').press("Enter");
}

async function selectModel(page: any, model: string) {
  // 按 value 选择（option label 带 · Go · E2E Mock 后缀，精确 label 匹配会等满超时）
  await page.locator(".model-wrap select").selectOption(model, { timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 20_000 });
});

test("TEST1 reasoning + final", async ({ page }) => {
  await selectModel(page, "mock-reasoning-final");
  await sendPrompt(page, "物理题");
  await expect(page.locator(".reasoning")).toBeVisible({ timeout: 20_000 });
  // reasoning 默认折叠，先展开再断言正文
  await page.locator(".reasoning summary").click();
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
  // 第二轮应新增一条 assistant 消息并正常流式返回（mock-reasoning-final 仍是"最终回答…"）
  await expect(page.locator(".msg-parts.assistant")).toHaveCount(2, { timeout: 20_000 });
  await expect(page.locator(".msg-parts.assistant .msg-text").last()).toContainText("临界角速度", { timeout: 20_000 });
  await expect(page.locator("body")).not.toContainText("Empty messages are not allowed");
});

test("TEST4 user KaTeX", async ({ page }) => {
  await selectModel(page, "mock-lifecycle");
  await sendPrompt(page, "一个质量为 \\(m\\) 的小珠沿半径为 \\(R\\) 的圆环运动，角速度为 \\(\\omega\\)。");
  await expect(page.locator(".msg-parts.user .msg-text .katex").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".msg-parts.user .msg-text")).not.toContainText("\\(");
});

test("TEST5 assistant KaTeX", async ({ page }) => {
  await selectModel(page, "mock-katex");
  await sendPrompt(page, "输出公式");
  await expect(page.locator(".msg-parts.assistant .msg-text .katex-display")).toBeVisible({ timeout: 20_000 });
  // KaTeX 的隐藏 <annotation> 含原始 TeX（可访问性/复制用，视觉不可见）；
  // 用 innerText 验证用户看到的文本不泄漏 raw LaTeX
  const visible = await page.locator(".msg-parts.assistant .msg-text").innerText();
  expect(visible).not.toContain("\\Omega=");
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

test("TEST8 代码块高亮 + 一键复制", async ({ page }) => {
  await selectModel(page, "mock-code");
  await sendPrompt(page, "输出一段 TS 代码");
  const codeWrap = page.locator(".msg-parts.assistant .code-wrap").first();
  await expect(codeWrap).toBeVisible({ timeout: 20_000 });
  // 语法高亮已应用（hljs token）
  await expect(codeWrap.locator(".hljs-keyword").first()).toBeVisible();
  await expect(codeWrap.locator(".hljs-comment").first()).toBeVisible();
  // 一键复制代码并给出成功反馈（clipboard.readText 需权限，改为只验证按钮反馈）
  await codeWrap.locator(".code-copy").click();
  await expect(codeWrap.locator(".code-copy")).toContainText("已复制 ✓");
});

test("TEST9 message 一键复制", async ({ page }) => {
  await selectModel(page, "mock-reasoning-final");
  await sendPrompt(page, "物理题");
  await expect(page.locator(".msg-parts.assistant .msg-text")).toContainText("最终回答", { timeout: 20_000 });
  const copyBtn = page.locator(".msg-copy").first();
  await copyBtn.click();
  await expect(copyBtn).toContainText("已复制 ✓");
});

test("TEST10 设置视图 + 主题切换", async ({ page }) => {
  await page.locator("header .icon-btn").first().click();
  await page.locator(".side-nav").filter({ hasText: "设置" }).click();
  await expect(page.locator(".settings-view")).toBeVisible();
  await expect(page.locator(".settings-grid label")).toHaveCount(6);
  const themeSel = page.locator(".settings-grid label").filter({ hasText: "主题" }).locator("select");
  await themeSel.selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await themeSel.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await themeSel.selectOption("system");
  // 返回聊天
  await page.locator("header .icon-btn").last().click();
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible();
});

test("TEST11 个性化记忆添加 + 持久化", async ({ page }) => {
  await page.locator("header .icon-btn").first().click();
  await page.locator(".side-nav").filter({ hasText: "个性化" }).click();
  await expect(page.locator(".pz-panel")).toBeVisible();
  const memorySection = page.locator(".pz-section").first();
  await memorySection.locator("textarea").fill("我是 E2E 测试用户，用中文交流");
  await memorySection.locator(".pz-btn").click();
  await expect(page.locator(".pz-list .pz-text").first()).toContainText("E2E 测试用户");
  const stored = await page.evaluate(() => localStorage.getItem("go-ai-personalization-v1") || "");
  expect(stored).toContain("E2E 测试用户");
});

test("TEST12 旧格式对话迁移不崩溃", async ({ page }) => {
  // 在页面脚本执行前注入旧格式数据，避免 app 用空数据覆盖
  await page.addInitScript(() => {
    localStorage.setItem("go-ai-conversations-v3", JSON.stringify([
      {
        id: "old-1",
        title: "旧对话",
        model: "kimi-k3",
        messages: [
          { role: "user", content: "你好" },
          { role: "assistant", content: "旧的回答", reasoning: "旧推理", attachments: [{ id: "a1", kind: "image", name: "x.png", mime: "image/png" }] },
          { role: "assistant", content: "", reasoning: "只有推理没有正文" },
          { role: "user", content: "第二轮" }
        ]
      },
      { id: "old-2" },
      "garbage",
      null
    ]));
  });
  await page.goto("/");
  // 应用不崩溃，且最近对话被自动恢复
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".msg-parts.user .msg-text").last()).toContainText("第二轮");
  // 旧 reasoning-only assistant 被过滤（不污染历史/上游）
  await expect(page.locator(".msg-parts.assistant")).toHaveCount(1);
  await expect(page.locator(".msg-parts.assistant .msg-text").first()).toContainText("旧的回答");
});

test("TEST13 移动端布局", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 20_000 });
  // 移动端侧栏默认收起（fixed 移出视口）
  await expect(page.locator(".sidebar")).not.toBeInViewport();
  // 打开侧栏 → 进设置
  await page.locator("header .icon-btn").first().click();
  await expect(page.locator(".sidebar")).toHaveClass(/open/);
  await page.locator(".side-nav").filter({ hasText: "设置" }).click();
  await expect(page.locator(".settings-view")).toBeVisible();
  // 返回聊天并发消息
  await page.locator("header .icon-btn").last().click();
  await selectModel(page, "mock-lifecycle");
  await sendPrompt(page, "你好");
  await expect(page.locator(".msg-parts.assistant .msg-text").last()).toContainText("你好", { timeout: 20_000 });
});
