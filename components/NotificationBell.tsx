"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Notification = {
  id: string;
  title: string;
  body: string;
  type: string;
  task_id: string | null;
  read: boolean;
  created_at: string;
};

/** 通知铃铛（TopNav 与 Mobile TopBar 共用）：按钮 + 下拉面板。 */
export default function NotificationBell() {
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
  );
}
