"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

type Notification = {
  id: string;
  title: string;
  body: string;
  type: string;
  task_id: string | null;
  read: boolean;
  created_at: string;
};

export default function TopNav() {
  const pathname = usePathname();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/notifications?limit=20", { cache: "no-store" });
    if (!response.ok) return;
    const body = (await response.json()) as { notifications: Notification[] };
    setNotifications(Array.isArray(body.notifications) ? body.notifications : []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 点击外部关闭
  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const unread = notifications.filter((n) => !n.read).length;

  async function markAllRead() {
    await fetch("/api/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    void load();
  }

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
          <a href="/workbench" className={pathname.startsWith("/workbench") ? "active" : ""}>工作区</a>
          <a href="/settings" className={pathname.startsWith("/settings") ? "active" : ""}>设置</a>
        </div>
        <div className="notif-wrap" ref={bellRef}>
          <button className={`notif-bell ${unread ? "has-unread" : ""}`} onClick={() => { if (!open) void load(); setOpen(!open); }} aria-label="通知">
            🔔{unread > 0 && <b>{unread > 99 ? "99+" : unread}</b>}
          </button>
          {open && (
            <div className="notif-panel">
              <div className="notif-head"><span>通知</span>{unread > 0 && <button onClick={() => void markAllRead()}>全部已读</button>}</div>
              {notifications.length === 0 && <p className="empty-copy">暂无通知</p>}
              {notifications.map((n) => (
                <a key={n.id} href={n.task_id ? `/tasks/${n.task_id}` : undefined} className={`notif-item ${n.read ? "read" : ""}`}>
                  <strong>{n.title}</strong>
                  <p>{n.body}</p>
                  <small>{new Date(n.created_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
