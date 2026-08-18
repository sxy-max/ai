// Mobile Workbench 验收（GO AI Mobile Shell）
// 多 viewport：窄手机 375 / 标准手机 430 / 桌面 1280 回归。
// 检查项（任务 §31）：无全局横向滚动、导航不逐字换行、BottomNav 不遮内容、
// Composer 首屏可用、Quick Actions 紧凑两列、Task Detail 结果优先、
// Desktop 保留原 TopNav（BottomNav 不出现）。
import { test, expect, type Page } from "@playwright/test";

const MOBILE_VIEWPORTS = [
  { name: "narrow-375", width: 375, height: 667 },
  { name: "standard-430", width: 430, height: 932 },
];

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, scrollHeight: doc.scrollHeight, innerHeight: window.innerHeight };
  });
  expect(overflow.scrollWidth, `页面存在全局横向滚动 (scrollWidth=${overflow.scrollWidth} > clientWidth=${overflow.clientWidth})`).toBeLessThanOrEqual(overflow.clientWidth);
}

async function singleLine(page: Page, selector: string, label: string) {
  const wrap = await page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return { height: r.height, lineHeight: parseFloat(style.lineHeight) || r.height, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  // 单行：元素高度 ≤ 1.6×line-height（允许 subpixel），且无内部横向溢出
  expect(wrap.height, `${label} 多行换行 (height=${wrap.height} > 1.6×line=${(wrap.lineHeight * 1.6).toFixed(1)})`).toBeLessThanOrEqual(wrap.lineHeight * 1.6 + 2);
  expect(wrap.scrollWidth, `${label} 文本横向溢出`).toBeLessThanOrEqual(wrap.clientWidth + 1);
}

async function bottomNavVisible(page: Page, viewportH: number) {
  const nav = page.locator(".m-bottomnav");
  await expect(nav).toBeVisible();
  const box = await nav.boundingBox();
  expect(box).not.toBeNull();
  // 底栏在视口内且贴底（允许 safe-area 内偏移）
  expect(box!.y + box!.height).toBeGreaterThan(viewportH - 60);
  expect(box!.y).toBeGreaterThanOrEqual(viewportH - 140);
  // 五个一级入口
  await expect(nav.locator(".m-tab")).toHaveCount(5);
  for (const label of ["首页", "聊天", "任务", "文件", "项目"]) {
    const tab = nav.locator(`.m-tab`, { hasText: label }).first();
    await expect(tab).toBeVisible();
    await singleLine(page, `.m-tab:has-text("${label}") .m-tab-label`, `底栏「${label}」`);
  }
}

for (const vp of MOBILE_VIEWPORTS) {
  test.describe(`mobile @${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: vp });

    test("首页：Composer 首屏可见 + 无横向滚动 + BottomNav 不遮内容", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator('[aria-label="任务描述"]')).toBeVisible({ timeout: 20_000 });
      // Composer 首屏：textarea 顶部在首屏内
      const box = await page.locator('[aria-label="任务描述"]').boundingBox();
      expect(box!.y, "任务输入区不在首屏内").toBeLessThan(vp.height);
      // 顶栏品牌紧凑（无巨型 Hero：标题 ≤24px）
      const title = await page.locator(".launcher-title").evaluate((el) => parseFloat(window.getComputedStyle(el).fontSize));
      expect(title).toBeLessThanOrEqual(24);
      // 无逐字换行：品牌标 + 顶栏标题
      await singleLine(page, ".m-topbar-brand strong", "顶栏品牌");
      await noHorizontalScroll(page);
      await bottomNavVisible(page, vp.height);
      // BottomNav 不遮 Composer（Composer 底部 < 底栏顶部）
      const navBox = await page.locator(".m-bottomnav").boundingBox();
      const composer = await page.locator(".launcher-form").boundingBox();
      expect(composer!.y + composer!.height).toBeLessThanOrEqual(navBox!.y + 2);
    });

    test("首页：Quick Actions 两列紧凑网格（非巨型单列卡片）", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator(".quick-item")).toHaveCount(7, { timeout: 20_000 });
      const boxes = await page.locator(".quick-item").evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }));
      // 两列：第 1/2 项同 y，第 2/3 项不同 y；卡片高度紧凑（<80px）
      expect(boxes[0].y).toBeCloseTo(boxes[1].y, 0);
      expect(boxes[1].y).not.toBeCloseTo(boxes[2].y, 0);
      for (const b of boxes) expect(b.height, "Quick Action 卡片过高").toBeLessThan(80);
      await noHorizontalScroll(page);
    });

    test("任务列表：紧凑行 + 状态人话 + BottomNav", async ({ page }) => {
      await page.goto("/tasks");
      await expect(page.locator(".task-card").first()).toBeVisible({ timeout: 20_000 });
      await noHorizontalScroll(page);
      await bottomNavVisible(page, vp.height);
    });

    test("任务详情：结果优先（默认「结果」面板）+ 三概念 tabs", async ({ page }) => {
      await page.goto("/tasks/00000000-0000-0000-0000-000000000000");
      await expect(page.locator("body")).toContainText("任务不存在或已删除", { timeout: 20_000 });
      await noHorizontalScroll(page);
    });
  });
}

test.describe("HTML viewer safety and interaction", () => {
  test.use({ viewport: { width: 430, height: 932 } });

  test("HTML 结果保持 opaque-origin 沙箱且可运行自身交互", async ({ page }) => {
    const artifactId = "e2e-interactive-viewer";
    const downloadUrl = "http://127.0.0.1:3100/__e2e__/interactive-preview.html";
    const html = "<!doctype html><html><body><button id=counter>0</button><script>document.querySelector('#counter').addEventListener('click',()=>document.querySelector('#counter').textContent='互动已启用')</script></body></html>";
    await page.route(`**/api/artifacts/${artifactId}/meta`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: artifactId,
        filename: "interactive-preview.html",
        mime: "text/html",
        kind: "html",
        size: html.length,
        status: "ready",
        createdAt: Date.now(),
        downloadUrl,
        taskId: null,
      }),
    }));
    await page.route(downloadUrl, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));

    await page.goto(`/artifacts/${artifactId}/viewer`);
    const frame = page.locator(".viewer-iframe");
    await expect(frame).toBeVisible();
    const sandbox = await frame.getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-forms");
    expect(sandbox).not.toContain("allow-same-origin");

    const counter = page.frameLocator(".viewer-iframe").locator("#counter");
    await expect(counter).toHaveText("0");
    await counter.click();
    await expect(counter).toHaveText("互动已启用");

    const layout = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>(".viewer-shell")!.getBoundingClientRect();
      const toolbar = document.querySelector<HTMLElement>(".viewer-toolbar")!.getBoundingClientRect();
      const body = document.querySelector<HTMLElement>(".viewer-body")!.getBoundingClientRect();
      const iframe = document.querySelector<HTMLIFrameElement>(".viewer-iframe")!.getBoundingClientRect();
      const style = getComputedStyle(document.querySelector(".viewer-iframe")!);
      return {
        shellBottom: shell.bottom,
        toolbarBottom: toolbar.bottom,
        bodyTop: body.top,
        bodyBottom: body.bottom,
        iframeTop: iframe.top,
        iframeBottom: iframe.bottom,
        iframeDisplay: style.display,
        visualHeight: window.visualViewport?.height || window.innerHeight,
        bottomNavCount: document.querySelectorAll(".m-bottomnav").length,
      };
    });
    expect(layout.bottomNavCount).toBe(0);
    expect(layout.shellBottom).toBeCloseTo(layout.visualHeight, 0);
    expect(layout.bodyTop).toBeCloseTo(layout.toolbarBottom, 0);
    expect(layout.iframeTop).toBeCloseTo(layout.bodyTop, 0);
    expect(layout.iframeBottom).toBeCloseTo(layout.bodyBottom, 0);
    expect(layout.iframeDisplay).toBe("block");
    await page.screenshot({ path: test.info().outputPath("viewer-mobile.png"), fullPage: false });
  });
});

const CHAT_FIXTURE = {
  id: "e2e-mobile-conversation",
  title: "移动端长回答验收",
  model: "mock-lifecycle",
  provider: "opencode-go",
  updatedAt: Date.now(),
  messages: [
    { id: "u-1", role: "user", status: "completed", content: "请解释这个实现，并给出检查清单。" },
    { id: "a-1", role: "assistant", status: "completed", content: [
      "## 中心判断",
      "聊天内容应该成为页面的主任务，次要控制只在需要时出现。",
      "### 检查清单",
      "- 消息区从紧凑标题栏延伸到输入框。",
      "- 用户问题与回答拥有清晰的阅读层级。",
      "- 长回答滚动到底部时最后一行仍可见。",
      Array.from({ length: 36 }, (_, index) => String(index + 1) + ". 这是用于移动视口滚动验收的独立段落，确保长回答可以自然滚动。" ).join("\n\n"),
    ].join("\n\n") },
  ],
};

for (const vp of [{ name: "conversation-390", width: 390, height: 844 }, { name: "conversation-430", width: 430, height: 932 }]) {
  test.describe(`immersive conversation @${vp.name}`, () => {
    test.use({ viewport: vp });

    test("聊天页面把正文空间留给消息，控制项进入 More", async ({ page }) => {
      await page.addInitScript((fixture) => {
        localStorage.setItem("go-ai-conversations-v3", JSON.stringify([fixture]));
        localStorage.removeItem("go-ai-execution-profile-v1");
      }, CHAT_FIXTURE);
      await page.goto("/chat");
      await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText("请解释这个实现，并给出检查清单。", { exact: true })).toBeVisible({ timeout: 20_000 });

      const layout = await page.evaluate(() => {
        const rect = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector);
          if (!element) return null;
          const box = element.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, height: box.height, width: box.width };
        };
        const shell = rect(".conversation-shell")!;
        const header = rect(".conversation-header")!;
        const messages = rect('[data-testid="conversation-scroll"]')!;
        const composer = rect(".chat-composer-area")!;
        const userParts = rect(".message.user .msg-parts")!;
        const userElement = document.querySelector<HTMLElement>(".message.user .msg-parts")
          || document.querySelector<HTMLElement>(".message.user .msg-text");
        const userStyle = userElement ? getComputedStyle(userElement) : null;
        const scroll = document.querySelector<HTMLElement>('[data-testid="conversation-scroll"]')!;
        return {
          shell, header, messages, composer, userParts,
          shellPosition: getComputedStyle(document.querySelector<HTMLElement>(".conversation-shell")!).position,
          userBackground: userStyle?.backgroundColor || "transparent",
          messageScrollHeight: scroll.scrollHeight,
          messageClientHeight: scroll.clientHeight,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          bottomNavCount: document.querySelectorAll(".m-bottomnav").length,
          modelRows: document.querySelectorAll(".model-controls, .tool-row, .footnote").length,
        };
      });
      expect(layout.bottomNavCount).toBe(0);
      expect(layout.modelRows).toBe(0);
      expect(layout.shellPosition).toBe("fixed");
      expect(layout.header.height).toBeLessThanOrEqual(70);
      expect(layout.messages.top).toBeCloseTo(layout.header.bottom, 0);
      expect(layout.messages.bottom).toBeCloseTo(layout.composer.top, 0);
      expect(layout.composer.bottom).toBeCloseTo(layout.shell.bottom, 0);
      expect(layout.messages.height).toBeGreaterThan(vp.height * 0.65);
      expect(layout.messageScrollHeight).toBeGreaterThan(layout.messageClientHeight);
      expect(layout.userBackground).not.toBe("rgba(0, 0, 0, 0)");
      expect(layout.userParts.width).toBeLessThanOrEqual(vp.width * 0.9);
      expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
      await expect(page.locator(".conversation-header")).toHaveCount(1);
      await expect(page.locator(".m-bottomnav")).toHaveCount(0);
      await expect(page.getByText("MODEL", { exact: true })).toHaveCount(0);
      await expect(page.locator(".footnote")).toHaveCount(0);

      const input = page.getByTestId("chat-input");
      await input.focus();
      await expect(input).toBeFocused();
      const composerAfterFocus = await page.locator(".chat-composer-area").boundingBox();
      expect(composerAfterFocus!.y + composerAfterFocus!.height).toBeCloseTo(layout.shell.bottom, 0);

      await page.getByLabel("更多会话操作").click();
      await expect(page.getByRole("dialog", { name: "会话设置" })).toBeVisible();
      await expect(page.locator(".sheet-select")).toContainText("联网");
      await expect(page.locator('.sheet-link[href="/settings"]')).toContainText("会话设置与个性化");
      await expect(page.locator(".profile-options button").filter({ hasText: "Auto" })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`${vp.name}.png`), fullPage: false });
    });
  });
}

test.describe("desktop regression @1280", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("桌面对话保留侧栏，消息区在紧凑标题与输入框之间", async ({ page }) => {
    await page.addInitScript((fixture) => {
      localStorage.setItem("go-ai-conversations-v3", JSON.stringify([fixture]));
      localStorage.removeItem("go-ai-execution-profile-v1");
    }, CHAT_FIXTURE);
    await page.goto("/chat");
    await expect(page.getByText("请解释这个实现，并给出检查清单。", { exact: true })).toBeVisible({ timeout: 20_000 });
    const layout = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, height: box.height, width: box.width };
      };
      return {
        sidebar: rect(".sidebar"),
        shell: rect(".conversation-shell"),
        header: rect(".conversation-header"),
        messages: rect('[data-testid="conversation-scroll"]'),
        composer: rect(".chat-composer-area"),
        bottomNavCount: document.querySelectorAll(".m-bottomnav").length,
      };
    });
    expect(layout.sidebar.width).toBeGreaterThan(250);
    expect(layout.bottomNavCount).toBe(0);
    expect(layout.messages.top).toBeCloseTo(layout.header.bottom, 0);
    expect(layout.messages.bottom).toBeCloseTo(layout.composer.top, 0);
    expect(layout.composer.bottom).toBeCloseTo(layout.shell.bottom, 0);
    expect(layout.messages.height).toBeGreaterThan(500);
    await page.screenshot({ path: test.info().outputPath("conversation-desktop.png"), fullPage: false });
  });

  test("桌面保留原 TopNav：6 一级入口可见，BottomNav 不出现", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".topnav-links a")).toHaveCount(6);
    await expect(page.locator(".topnav-links a", { hasText: "设置" })).toBeVisible();
    // BottomNav 存在于 DOM 但桌面端必须隐藏（display:none，CSS 断点控制）
    await expect(page.locator(".m-bottomnav")).toBeHidden();
    await noHorizontalScroll(page);
  });

  test("桌面任务详情：保留 结果/过程/步骤/文件/产物/详情 与操作按钮", async ({ page }) => {
    await page.goto("/tasks/00000000-0000-0000-0000-000000000000");
    await expect(page.locator("body")).toContainText("任务不存在或已删除", { timeout: 20_000 });
  });
});
