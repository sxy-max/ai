"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { STATUS_META } from "./status-meta";
import TopNav from "../../components/TopNav";

type TaskItem = {
  id: string;
  title: string;
  goal: string;
  status: string;
  progress: number;
  current_stage: string;
  artifact_count: number | null;
  steps_done: number | null;
  steps_total: number | null;
  error: string;
  created_at: string;
};

export default function TasksPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [needsLogin, setNeedsLogin] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/tasks?limit=100", { cache: "no-store" });
    if (response.status === 401) { setNeedsLogin(true); return; }
    const body = await response.json().catch(() => ({}));
    setTasks(Array.isArray(body.tasks) ? body.tasks : []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (needsLogin) router.replace("/login"); }, [needsLogin, router]);

  // 活动中的任务轮询刷新（queued/planning/running/waiting_user/paused）
  useEffect(() => {
    const active = tasks.some((t) => ["queued", "planning", "running", "waiting_user", "paused"].includes(t.status));
    if (!active) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [tasks, load]);

  const shown = filter === "all" ? tasks : tasks.filter((t) => t.status === filter);
  const counts = tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <main className="home-shell">
      <TopNav />

      <section className="tasks-section">
        <header className="tasks-header">
          <div>
            <h1>任务</h1>
            <p>所有任务在后台持续执行，关闭页面也不中断。</p>
          </div>
          <a href="/" className="new-task-btn">＋ 新任务</a>
        </header>

        <div className="status-tabs">
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部 <b>{tasks.length}</b></button>
          {Object.entries(STATUS_META).map(([status, meta]) => (
            counts[status] ? (
              <button key={status} className={filter === status ? "active" : ""} onClick={() => setFilter(status)}>
                {meta.label} <b>{counts[status]}</b>
              </button>
            ) : null
          ))}
        </div>

        {loading ? <p className="empty-copy">加载中…</p> : shown.length === 0 ? (
          <div className="tasks-empty">
            <span>01</span>
            <h3>{filter === "all" ? "还没有任务" : "这个状态下没有任务"}</h3>
            <p>在首页描述目标并开始第一个任务。</p>
          </div>
        ) : (
          <div className="task-list">
            {shown.map((task) => {
              const meta = STATUS_META[task.status] || STATUS_META.queued;
              const total = task.steps_total ?? 0;
              const done = task.steps_done ?? 0;
              return (
                <a key={task.id} href={`/tasks/${task.id}`} className="task-card">
                  <div className="task-card-head">
                    <span className={`status-badge ${task.status}`}>{meta.label}</span>
                    <small>{new Date(task.created_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
                  </div>
                  <h3>{task.title}</h3>
                  <p className="task-card-goal">{task.goal}</p>
                  <div className="task-card-progress">
                    <div className="progress-track"><div style={{ width: `${task.progress}%` }} /></div>
                    <span>{task.progress}%</span>
                  </div>
                  <div className="task-card-meta">
                    <span>{task.current_stage || "等待执行"}</span>
                    <span>{total ? `步骤 ${done}/${total}` : ""}{task.artifact_count ? ` · 产物 ${task.artifact_count}` : ""}</span>
                  </div>
                  {task.status === "failed" && task.error && <p className="task-card-error">{task.error}</p>}
                </a>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
