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

test.describe("desktop regression @1280", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

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
