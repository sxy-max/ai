"use client";

import { usePathname } from "next/navigation";
import NotificationBell from "./NotificationBell";

/** Desktop 顶部一级导航：品牌 + 6 入口 + 通知（Mobile 由 AppShell 提供独立壳）。 */
export default function TopNav() {
  const pathname = usePathname();
  return (
    <nav className="topnav">
      <div className="topnav-brand"><span className="eyebrow">GO AI</span><strong>云端 AI 工作系统</strong></div>
      <div className="topnav-right">
        <div className="topnav-links">
          <a href="/" className={pathname === "/" ? "active" : ""}>首页</a>
          <a href="/chat" className={pathname.startsWith("/chat") ? "active" : ""}>聊天</a>
          <a href="/tasks" className={pathname.startsWith("/tasks") ? "active" : ""}>任务</a>
          <a href="/files" className={pathname.startsWith("/files") ? "active" : ""}>文件</a>
          <a href="/projects" className={pathname.startsWith("/projects") ? "active" : ""}>项目</a>
          <a href="/settings" className={pathname.startsWith("/settings") ? "active" : ""}>设置</a>
        </div>
        <NotificationBell />
      </div>
    </nav>
  );
}
