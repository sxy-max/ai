"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { STATUS_META, WORKER_LABELS, STEP_STATUS_LABELS, readableBytes, eventLabel, AGENT_STAGE_LABELS } from "../status-meta";
import TopNav from "../../../components/TopNav";

type TaskDetail = {
  task: {
    id: string; title: string; goal: string; status: string; priority: string;
    progress: number; current_stage: string; plan: unknown[]; result_summary: string;
    error: string; created_at: string; started_at: string | null; completed_at: string | null;
  };
  steps: Array<{ id: string; seq: number; worker_type: string; title: string; goal: string; status: string; detail: Record<string, unknown> | null; error: string; started_at: string | null; completed_at: string | null }>;
  artifacts: Array<{ id: string; name: string; type: string; version: number; size: number; mime: string; status: string; downloadUrl: string; created_at: string }>;
  events: Array<{ id: string; type: string; payload: Record<string, unknown>; created_at: string }>;
};

const ACTIVE_STATUSES = new Set(["queued", "planning", "running", "waiting_user", "paused"]);

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [tab, setTab] = useState("activity");
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [liveEvents, setLiveEvents] = useState<TaskDetail["events"]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  const loadDetail = useCallback(async () => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (response.status === 401) { setNeedsLogin(true); return; }
    if (!response.ok) { setError("任务不存在或已删除"); return; }
    const body = (await response.json()) as TaskDetail;
    setDetail(body);
  }, [id]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);
  useEffect(() => { if (needsLogin) router.replace("/login"); }, [needsLogin, router]);

  // 轮询兜底（SSE 断连/重连间隙）：活动状态每 5s 刷新
  useEffect(() => {
    if (!detail || !ACTIVE_STATUSES.has(detail.task.status)) return;
    const timer = setInterval(() => void loadDetail(), 5000);
    return () => clearInterval(timer);
  }, [detail?.task.status, loadDetail]);

  // SSE 实时事件流（PRD §64）；按事件 id 去重
  useEffect(() => {
    if (!id) return;
    const source = new EventSource(`/api/tasks/${encodeURIComponent(id)}/events`);
    eventSourceRef.current = source;
    source.addEventListener("task", (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as TaskDetail["events"][number];
        setLiveEvents((events) => {
          if (events.some((e) => e.id === parsed.id)) return events;
          return [...events, parsed];
        });
        // 状态变化事件 → 刷新任务本体
        if (["task.completed", "task.failed", "task.cancelled", "task.paused", "task.resumed", "task.retried", "plan.created"].includes(parsed.type)) {
          void loadDetail();
        }
      } catch {}
    });
    return () => { source.close(); eventSourceRef.current = null; };
  }, [id, loadDetail]);

  const allEvents = useMemo(() => {
    const seen = new Set<string>();
    const merged: TaskDetail["events"] = [];
    for (const event of [...(detail?.events || []), ...liveEvents]) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      merged.push(event);
    }
    return merged.sort((a, b) => (a.id > b.id ? 1 : -1));
  }, [detail, liveEvents]);

  async function runAction(action: "pause" | "resume" | "cancel" | "retry") {
    if (busyAction) return;
    setBusyAction(action);
    setError("");
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
        cache: "no-store"
      });
      if (response.status === 401) { setNeedsLogin(true); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "操作失败");
      await loadDetail();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusyAction("");
    }
  }

  if (!detail) {
    return (
      <main className="home-shell">
        <TopNav />
        <section className="tasks-section"><p className="empty-copy">{error || "加载中…"}</p></section>
      </main>
    );
  }

  const { task, steps, artifacts } = detail;

  // WP9：当前 Agent 阶段（最新 progress.stage）
  const currentStage = useMemo(() => {
    const progressEvents = allEvents.filter((e) => e.type === "progress" && e.payload?.stage);
    const latest = progressEvents[progressEvents.length - 1];
    return latest ? String(latest.payload.stage) : "";
  }, [allEvents]);
  const statusMeta = STATUS_META[task.status] || STATUS_META.queued;
  const canPause = task.status === "running" || task.status === "planning";
  const canResume = task.status === "paused" || task.status === "waiting_user";
  const canCancel = ["queued", "planning", "running", "waiting_user", "paused"].includes(task.status);
  const canRetry = task.status === "failed" || task.status === "cancelled";

  return (
    <main className="home-shell">
      <TopNav />

      <section className="task-detail">
        <header className="task-detail-header">
          <div className="task-detail-title">
            <a href="/tasks" className="back-link">← 任务列表</a>
            <h1>{task.title}</h1>
            <p>{task.goal}</p>
            <small>创建于 {new Date(task.created_at).toLocaleString("zh-CN")}</small>
          </div>
          <div className="task-detail-actions">
            <span className={`status-badge ${task.status}`}>{statusMeta.label}</span>
            {canPause && <button onClick={() => void runAction("pause")} disabled={!!busyAction}>暂停</button>}
            {canResume && <button onClick={() => void runAction("resume")} disabled={!!busyAction}>继续</button>}
            {canCancel && <button className="danger" onClick={() => void runAction("cancel")} disabled={!!busyAction}>取消</button>}
            {canRetry && <button onClick={() => void runAction("retry")} disabled={!!busyAction}>重试</button>}
          </div>
        </header>

        <div className="task-detail-progress">
          <div className="progress-track"><div style={{ width: `${task.progress}%` }} /></div>
          <span>{task.progress}%</span>
          <b>{AGENT_STAGE_LABELS[currentStage] || task.current_stage || "等待执行"}</b>
        </div>

        {error && <div className="workbench-alert"><span>{error}</span><button onClick={() => setError("")}>关闭</button></div>}
        {task.error && task.status === "failed" && <div className="task-error-box">{task.error}</div>}

        <div className="task-detail-tabs">
          <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>活动</button>
          <button className={tab === "steps" ? "active" : ""} onClick={() => setTab("steps")}>步骤</button>
          <button className={tab === "artifacts" ? "active" : ""} onClick={() => setTab("artifacts")}>产物 <b>{artifacts.length}</b></button>
          <button className={tab === "detail" ? "active" : ""} onClick={() => setTab("detail")}>详情</button>
        </div>

        <div className="task-detail-body">
          <section className={`detail-pane ${tab === "activity" || tab === "steps" ? "shown" : ""}`}>
            {tab === "activity" ? (
              <div className="run-timeline">
                {!allEvents.length && <div className="empty-run"><span>01</span><h3>等待执行</h3><p>任务入队后，系统会在这里实时展示每一步进展。</p></div>}
                {allEvents.map((event) => (
                  <article key={event.id} className={`run-event ${event.type.includes("failed") ? "failed" : ""}`}>
                    <i>{event.type === "task.completed" ? "✓" : event.type.includes("failed") ? "✗" : "·"}</i>
                    <div>
                      <small>{event.type.replaceAll(".", " · ")}</small>
                      <p>{eventLabel(event.type, event.payload)}</p>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="steps-list">
                {!steps.length && <p className="empty-copy">规划生成后显示步骤清单。</p>}
                {steps.map((step) => (
                  <article key={step.id} className={`step-card ${step.status}`}>
                    <div className="step-head">
                      <span className="step-seq">{String(step.seq).padStart(2, "0")}</span>
                      <div><strong>{step.title}</strong><small>{WORKER_LABELS[step.worker_type] || step.worker_type}</small></div>
                      <span className={`status-badge ${step.status}`}>{STEP_STATUS_LABELS[step.status] || step.status}</span>
                    </div>
                    <p className="step-goal">{step.goal}</p>
                    {step.error && <p className="task-card-error">{step.error}</p>}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className={`detail-pane side ${tab === "artifacts" || tab === "detail" ? "shown" : ""}`}>
            {tab === "artifacts" ? (
              <div className="artifact-grid">
                {!artifacts.length && <p className="empty-copy">任务完成后，这里展示可下载的文件。</p>}
                {artifacts.map((artifact) => (
                  <a key={artifact.id} href={artifact.downloadUrl} className="artifact-card">
                    <div className="artifact-icon">{artifact.type.slice(0, 3).toUpperCase()}</div>
                    <div><strong>{artifact.name}</strong><small>v{artifact.version} · {readableBytes(artifact.size)} · {artifact.type}</small></div>
                    <span>下载 ↓</span>
                  </a>
                ))}
              </div>
            ) : (
              <div className="detail-notes">
                <h3>目标</h3><p>{task.goal}</p>
                {task.result_summary && <><h3>结果摘要</h3><p>{task.result_summary}</p></>}
                <h3>规划（{Array.isArray(task.plan) ? task.plan.length : 0} 步）</h3>
                {Array.isArray(task.plan) && task.plan.map((step, index) => (
                  <p key={index} className="plan-line">
                    <b>{index + 1}.</b> {String((step as { title?: string }).title || "步骤")} — {String((step as { worker_type?: string }).worker_type || "")}
                  </p>
                ))}
                {task.completed_at && <><h3>完成时间</h3><p>{new Date(task.completed_at).toLocaleString("zh-CN")}</p></>}
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
