"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AppShell from "../components/AppShell";

/** 首页 = 任务启动器（Mobile Workbench）：
 *  紧凑 TopBar → Task Composer（首屏工作单元）→ 最近进行中任务（存在才显示）
 *  → Quick Actions（模式提示，2 列紧凑）→ 底部说明。
 *  先工作，再品牌，再模板；不为了填满首页硬加区块。 */

const QUICK_ENTRIES = [
  { label: "研究", icon: "🔍", hint: "例如：调研某技术/市场，给出关键事实与结论" },
  { label: "分析文件", icon: "📑", hint: "例如：分析我上传的文件，提取关键信息并总结要点" },
  { label: "写文档", icon: "📝", hint: "例如：根据材料写一份结构清晰的文档" },
  { label: "做表格", icon: "📊", hint: "例如：把材料整理成 Excel 表格，说明需要的列" },
  { label: "做 PPT", icon: "🖥️", hint: "例如：把材料做成演示文稿，要点突出" },
  { label: "做网页", icon: "🌐", hint: "例如：把材料做成一个移动端优先的信息网页" },
  { label: "写程序", icon: "⚙️", hint: "例如：实现一个程序，说明输入输出并验证" },
];

type RecentTask = {
  id: string;
  title: string;
  status: string;
  progress: number;
  current_stage: string;
  artifact_count: number | null;
  created_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中", planning: "规划中", running: "执行中",
  preparing_workspace: "准备工作区", validating: "验证产物", retrying: "自动修复中",
  waiting_user: "等待用户", paused: "已暂停", completed: "已完成",
  failed: "失败", cancelled: "已取消",
};

const ACTIVE_SET = new Set(["queued", "planning", "running", "preparing_workspace", "validating", "retrying", "waiting_user", "paused"]);

export default function HomePage() {
  const router = useRouter();
  const [goal, setGoal] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [placeholder, setPlaceholder] = useState("描述目标：分析这些资料，做一个总结、一份 Excel 和 PPT");
  const [activeHint, setActiveHint] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentTask[]>([]);
  const [parentTaskId, setParentTaskId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 未登录检测：任何 401 跳登录页
  const checkAuth = useCallback((status: number) => {
    if (status === 401) router.replace("/login");
  }, [router]);

  // 最近任务（进行中优先；存在才显示）
  const loadRecent = useCallback(async () => {
    const response = await fetch("/api/tasks?limit=6", { cache: "no-store" });
    if (response.status === 401) { router.replace("/login"); return; }
    const body = await response.json().catch(() => ({}));
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    const active = tasks.filter((t: RecentTask) => ACTIVE_SET.has(t.status));
    const done = tasks.filter((t: RecentTask) => t.status === "completed").slice(0, 2);
    setRecent([...active, ...done].slice(0, 5));
  }, [router]);

  useEffect(() => { void loadRecent(); }, [loadRecent]);

  // 「继续处理」入口：从 Task Detail / Artifact Viewer 带 ?goal= / ?parent= / ?artifact= 预填。
  // 上一轮产物作为附件重传（客户端 blob，走同一 Preflight 主链，不绕过）；一次性处理并清 URL。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const goal = params.get("goal");
    const parent = params.get("parent");
    const artifact = params.get("artifact");
    if (!goal && !parent && !artifact) return;
    if (goal) setGoal(goal);
    if (parent) setParentTaskId(parent);
    if (artifact) {
      void (async () => {
        try {
          const metaRes = await fetch(`/api/artifacts/${encodeURIComponent(artifact)}/meta`, { cache: "no-store" });
          if (!metaRes.ok) return;
          const meta = (await metaRes.json()) as { filename?: string; downloadUrl?: string };
          if (!meta.downloadUrl) return;
          const blobRes = await fetch(meta.downloadUrl, { cache: "no-store" });
          if (!blobRes.ok) return;
          const blob = await blobRes.blob();
          const file = new File([blob], String(params.get("artifactName") || meta.filename || `产物-${artifact.slice(0, 8)}`), { type: blob.type || "application/octet-stream" });
          setFiles((current) => (current.some((f) => f.name === file.name) ? current : [...current, file].slice(0, 20)));
        } catch {}
      })();
    }
    window.history.replaceState({}, "", "/");
  }, []);

  // 有运行中任务时轮询
  useEffect(() => {
    const hasActive = recent.some((t) => ACTIVE_SET.has(t.status));
    if (!hasActive) return;
    const timer = setInterval(() => void loadRecent(), 5000);
    return () => clearInterval(timer);
  }, [recent, loadRecent]);

  function pickFiles(list: FileList | null) {
    if (!list) return;
    const picked = Array.from(list).slice(0, 20 - files.length);
    setFiles((current) => [...current, ...picked]);
    if (fileInput.current) fileInput.current.value = "";
  }

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, i) => i !== index));
  }

  // 点击 Quick Action：只改变 Composer 的任务意图提示（不绕过 Preflight）
  function applyHint(hint: string) {
    setPlaceholder(hint);
    setActiveHint(hint);
    if (textareaRef.current) textareaRef.current.focus();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!goal.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("goal", goal.trim());
      if (parentTaskId) form.append("parentTaskId", parentTaskId);
      files.forEach((file) => form.append("files", file));
      const response = await fetch("/api/tasks", { method: "POST", body: form, cache: "no-store" });
      checkAuth(response.status);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "任务创建失败");
      setGoal(""); setFiles([]); setActiveHint(null);
      router.push(`/tasks/${body.task.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "任务创建失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="home-shell">
      <AppShell />

      <section className="launcher">
        <h1 className="launcher-title">想让 AI 做什么？</h1>

        {/* Primary Task Composer：一个完整工作单元 */}
        <form className="launcher-form" onSubmit={submit}>
          <textarea
            ref={textareaRef}
            value={goal}
            onChange={(event) => {
              setGoal(event.target.value);
              // 输入后自然增长，但不能无限撑高页面
              event.target.style.height = "auto";
              event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
            }}
            placeholder={placeholder}
            rows={2}
            aria-label="任务描述"
          />

          {files.length > 0 && (
            <div className="composer-files">
              {files.map((file, index) => (
                <span className="file-chip" key={`${file.name}-${index}`}>
                  {file.name}
                  <button type="button" aria-label={`移除 ${file.name}`} onClick={() => removeFile(index)}>×</button>
                </span>
              ))}
            </div>
          )}

          {activeHint && <p className="composer-hint">{activeHint}</p>}

          <div className="launcher-bar">
            <input ref={fileInput} type="file" multiple hidden onChange={(event) => pickFiles(event.target.files)} />
            <button type="button" className="attach-btn" onClick={() => fileInput.current?.click()} disabled={busy}>＋ 添加文件</button>
            <button type="submit" className="launcher-go" disabled={busy || !goal.trim()}>
              {busy ? "创建中…" : "开始任务 →"}
            </button>
          </div>
          {error && <p className="launcher-error">{error}</p>}
        </form>

        {/* 最近正在进行 / 可继续的任务（存在才显示） */}
        {recent.length > 0 && (
          <div className="recent-tasks">
            <h2>最近任务</h2>
            {recent.map((task) => (
              <a key={task.id} href={`/tasks/${task.id}`} className="recent-task">
                <span className={`status-dot ${task.status}`} />
                <span className="recent-task-title">{task.title}</span>
                <span className="recent-task-meta">
                  {STATUS_LABEL[task.status] || task.status}
                  {task.status === "running" ? ` · ${task.progress}%` : ""}
                  {task.artifact_count ? ` · ${task.artifact_count} 个产物` : ""}
                </span>
                <span className="recent-task-go">›</span>
              </a>
            ))}
          </div>
        )}

        {/* Quick Actions：模式提示，不是巨大任务卡 */}
        <div className="quick-grid" aria-label="常用任务类型">
          {QUICK_ENTRIES.map((entry) => (
            <button
              key={entry.label}
              type="button"
              className={`quick-item ${activeHint === entry.hint ? "active" : ""}`}
              onClick={() => applyHint(entry.hint)}
            >
              <span className="quick-icon">{entry.icon}</span>
              <span className="quick-label">{entry.label}</span>
            </button>
          ))}
        </div>

        <p className="launcher-note">任务在后台持续执行，关闭页面也不中断；完成后可随时回来查看和下载产物。</p>
      </section>
    </main>
  );
}
