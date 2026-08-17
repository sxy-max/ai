"use client";

import { usePathname, useRouter } from "next/navigation";
import TopNav from "./TopNav";
import NotificationBell from "./NotificationBell";

/**
 * 全局 App Shell（Mobile 独立交互壳）：
 * - Desktop（≥761px）：保留现有 TopNav（顶部一级导航 + 通知）
 * - Mobile（≤760px）：紧凑 TopBar（品牌/返回+标题 + 通知/设置）+ 底部一级导航
 *   （首页/聊天/任务/文件/项目；设置从 TopBar 进入，不占底栏）
 * 同一个产品/路由/数据，只换 Interaction Shell；CSS 决定哪套显示。
 */

const BOTTOM_TABS = [
  { href: "/", label: "首页", icon: "🏠", match: (p: string) => p === "/" },
  { href: "/chat", label: "聊天", icon: "💬", match: (p: string) => p.startsWith("/chat") },
  { href: "/tasks", label: "任务", icon: "🗂", match: (p: string) => p.startsWith("/tasks") },
  { href: "/files", label: "文件", icon: "📄", match: (p: string) => p.startsWith("/files") },
  { href: "/projects", label: "项目", icon: "📦", match: (p: string) => p.startsWith("/projects") },
];

export default function AppShell({ title, backTo, noTopBar }: { title?: string; backTo?: string; noTopBar?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const isHome = pathname === "/";

  const back = () => {
    if (backTo) router.push(backTo);
    else if (window.history.length > 1) router.back();
    else router.push("/");
  };

  return (
    <>
      {/* Desktop：现有顶部一级导航 */}
      <div className="desktop-only"><TopNav /></div>

      {/* Mobile：紧凑 TopBar（页面自带 header 时可不渲染） */}
      {!noTopBar && (
      <header className="m-topbar mobile-only">
        {isHome ? (
          <a href="/" className="m-topbar-brand" aria-label="GO AI 首页">
            <span className="m-brand-orb">G</span>
            <strong>GO AI</strong>
          </a>
        ) : (
          <div className="m-topbar-nav">
            <button className="m-back" onClick={back} aria-label="返回">‹</button>
            <strong className="m-topbar-title">{title || "GO AI"}</strong>
          </div>
        )}
        <div className="m-topbar-actions">
          <NotificationBell />
          <a href="/settings" className="m-settings" aria-label="设置">⚙</a>
        </div>
      </header>
      )}

      {/* Mobile：底部一级导航（设置不占位） */}
      <nav className="m-bottomnav mobile-only" aria-label="主导航">
        {BOTTOM_TABS.map((tab) => (
          <a key={tab.href} href={tab.href} className={`m-tab ${tab.match(pathname) ? "active" : ""}`} aria-current={tab.match(pathname) ? "page" : undefined}>
            <span className="m-tab-icon">{tab.icon}</span>
            <span className="m-tab-label">{tab.label}</span>
          </a>
        ))}
      </nav>
    </>
  );
}
