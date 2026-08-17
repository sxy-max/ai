"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { STATUS_META, WORKER_LABELS, STEP_STATUS_LABELS, readableBytes, eventLabel, AGENT_STAGE_LABELS, STEP_PHASE_LABELS } from "../status-meta";
import AppShell from "../../../components/AppShell";
import RichContent from "../../../components/rich/RichContent";

type TaskDetail = {
  task: {
    id: string; title: string; goal: string; status: string; priority: string;
    progress: number; current_stage: string; plan: unknown[]; result_summary: string;
    error: string; created_at: string; started_at: string | null; completed_at: string | null;
  };
  // V1.3 WP31/33：Job 执行信息 + 失败语义
  job: {
    id: string; attempt: number; status: string; runtime: string | null;
    model: string | null; current_step: string | null; failure_code: string | null;
    failureLabel: string | null; created_at: string;
  } | null;
  steps: Array<{ id: string; seq: number; worker_type: string; phase?: string; title: string; goal: string; status: string; detail: Record<string, unknown> | null; error: string; started_at: string | null; completed_at: string | null }>;
  artifacts: Array<{ id: string; name: string; type: string; version: number; size: number; mime: string; status: string; downloadUrl: string; created_at: string }>;
  files: Array<{ id: string; filename: string; mime: string; size: number }>;
  events: Array<{ id: string; type: string; payload: Record<string, unknown>; created_at: string }>;
};

const ACTIVE_STATUSES = new Set(["queued", "planning", "running", "waiting_user", "paused"]);

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  // 结果优先：默认打开「结果」（desktop 双 pane 布局不受影响，两栏始终同显）
  const [tab, setTab] = useState("result");
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

  // WP9：当前 Agent 阶段（最新 progress.stage）——Hooks 必须在任何条件 return 之前
  const currentStage = useMemo(() => {
    const progressEvents = allEvents.filter((e) => e.type === "progress" && e.payload?.stage);
    const latest = progressEvents[progressEvents.length - 1];
    return latest ? String(latest.payload.stage) : "";
  }, [allEvents]);

  if (!detail) {
    return (
      <main className="home-shell">
        <AppShell title="任务详情" backTo="/tasks" />
        <section className="tasks-section"><p className="empty-copy">{error || "加载中…"}</p></section>
      </main>
    );
  }

  const { task, steps, artifacts, files = [], job } = detail;

  const statusMeta = STATUS_META[task.status] || STATUS_META.queued;
  const canPause = task.status === "running" || task.status === "planning";
  const canResume = task.status === "paused" || task.status === "waiting_user";
  const canCancel = ["queued", "planning", "running", "waiting_user", "paused"].includes(task.status);
  const canRetry = task.status === "failed" || task.status === "cancelled";

  // 「继续处理」：回到首页 Composer 预填，延续当前 Task/Artifact lineage（沿用现有 parentTaskId，不发明新系统）
  function continueTask() {
    const goal = `继续处理任务「${task.title}」：${task.goal.slice(0, 120)}。请基于已有结果继续，输出更新后的文件。`;
    router.push(`/?goal=${encodeURIComponent(goal)}&parent=${encodeURIComponent(task.id)}`);
  }

  return (
    <main className="home-shell">
      <AppShell title="任务详情" backTo="/tasks" />

      <section className="task-detail">
        <header className="task-detail-header">
          <div className="task-detail-title">
            <a href="/tasks" className="back-link">← 任务列表</a>
            <h1>{task.title}</h1>
            <p>{task.goal}</p>
            <small>创建于 {new Date(task.created_at).toLocaleString("zh-CN")}
              {job ? ` · 第 ${job.attempt} 次执行 · ${job.runtime || "runtime"}${job.model ? ` · ${job.model}` : ""}` : ""}
            </small>
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
        {/* V1.3 WP33：失败语义化（内部 failure_code 保留；用户看到可理解原因） */}
        {task.status === "failed" && (
          <div className="task-error-box">
            <b>{job?.failureLabel || "任务执行失败"}</b>
            {task.error && <small style={{ display: "block", opacity: 0.7, marginTop: 4 }}>{task.error}</small>}
          </div>
        )}

        {/* Desktop：双 pane 常显（标签仅视觉）；Mobile：用户概念三段（结果/过程/文件），raw 折叠到高级信息 */}
        <div className="task-detail-tabs">
          <button className={tab === "result" ? "active" : ""} onClick={() => setTab("result")}>结果</button>
          <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>过程</button>
          <button className={tab === "steps" ? "active" : ""} onClick={() => setTab("steps")}>步骤</button>
          {/* V1.3 WP32：文件区（上传文件独立展示，脱离 Chat bubble） */}
          <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>文件 <b>{files.length}</b></button>
          <button className={tab === "artifacts" ? "active" : ""} onClick={() => setTab("artifacts")}>产物 <b>{artifacts.length}</b></button>
          <button className={tab === "detail" ? "active" : ""} onClick={() => setTab("detail")}>详情</button>
        </div>

        <div className="task-detail-body">
          {/* 结果段（Mobile 主视图；desktop 双 pane 常显，此段仅窄屏显示） */}
          <section className={`detail-pane side result-pane-card ${tab === "result" ? "shown" : ""}`}>
            <div className="result-pane">
              <h3 className="result-pane-head">结果</h3>
              {task.result_summary ? (
                <RichContent content={task.result_summary} rawToggle copyButton />
              ) : task.status === "completed" ? (
                <p className="empty-copy">任务已完成，没有文本结果。</p>
              ) : (
                <p className="empty-copy">任务还在进行中，完成后这里显示最终答案。</p>
              )}

              {artifacts.length > 0 && (
                <>
                  <h3 className="result-pane-head">产物</h3>
                  <div className="artifact-grid">
                    {artifacts.map((artifact) => (
                      <a key={artifact.id} href={`/artifacts/${artifact.id}/viewer`} className="artifact-card">
                        <div className="artifact-icon">{artifact.type.slice(0, 3).toUpperCase()}</div>
                        <div><strong>{artifact.name}</strong><small>v{artifact.version} · {readableBytes(artifact.size)} · {artifact.type}</small></div>
                        <span>打开 →</span>
                      </a>
                    ))}
                  </div>
                </>
              )}

              <button className="continue-btn" onClick={continueTask}>↻ 继续处理这个任务</button>
            </div>
          </section>

          <section className={`detail-pane ${tab === "activity" || tab === "steps" || tab === "files" || tab === "process" || tab === "result" ? "shown" : ""}`}>
            {tab === "activity" || tab === "process" || tab === "result" ? (
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
                {/* Mobile：raw technical trace 折叠到高级信息 */}
                <details className="raw-trace">
                  <summary>高级信息（内部事件）</summary>
                  <div>
                    {allEvents.map((event) => (
                      <p key={event.id} className="raw-trace-line">{event.type} {JSON.stringify(event.payload)}</p>
                    ))}
                    {!allEvents.length && <p className="raw-trace-line">暂无事件</p>}
                  </div>
                </details>
              </div>
            ) : tab === "files" ? (
              <div className="files-list">
                {!files.length && <p className="empty-copy">本任务没有上传文件。</p>}
                {files.map((file) => (
                  <article key={file.id} className="file-card">
                    <div className="file-icon">{file.mime?.startsWith("image/") ? "IMG" : file.filename.split(".").pop()?.toUpperCase()?.slice(0, 3) || "FILE"}</div>
                    <div><strong>{file.filename}</strong><small>{readableBytes(file.size)} · {file.mime || "unknown"}</small></div>
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
                      <div><strong>{step.title}</strong><small>{WORKER_LABELS[step.worker_type] || step.worker_type}{step.phase ? ` · ${STEP_PHASE_LABELS[step.phase] || step.phase}` : ""}</small></div>
                      <span className={`status-badge ${step.status}`}>{STEP_STATUS_LABELS[step.status] || step.status}</span>
                    </div>
                    <p className="step-goal">{step.goal}</p>
                    {step.error && <p className="task-card-error">{step.error}</p>}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className={`detail-pane side ${tab === "artifacts" || tab === "detail" || tab === "result" ? "shown" : ""}`}>
            {tab === "artifacts" ? (
              <div className="artifact-grid">
                {!artifacts.length && <p className="empty-copy">任务完成后，这里展示可下载的文件。</p>}
                {artifacts.map((artifact) => (
                  <a key={artifact.id} href={`/artifacts/${artifact.id}/viewer`} className="artifact-card">
                    <div className="artifact-icon">{artifact.type.slice(0, 3).toUpperCase()}</div>
                    <div><strong>{artifact.name}</strong><small>v{artifact.version} · {readableBytes(artifact.size)} · {artifact.type}</small></div>
                    <span>打开 →</span>
                  </a>
                ))}
              </div>
            ) : (
              <div className="detail-notes">
                {task.result_summary && <><h3>结果摘要</h3><RichContent content={task.result_summary} /></>}
                <h3>目标</h3><p>{task.goal}</p>
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
