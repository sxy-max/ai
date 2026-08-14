"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Project } from "../../lib/workbench/projectStore";
import type { RunRecord } from "../../lib/workbench/runStore";
import type { WorkbenchEvent } from "../../lib/workbench/types";

type FileEntry = { name: string; is_dir: boolean; size_bytes: number | null };
type ProjectDetail = { project: Project; status: unknown; input: FileEntry[]; outputs: FileEntry[]; latestRun: RunRecord | null };

function eventLabel(event: WorkbenchEvent) {
  if (event.kind === "status") return "沙盒开始执行";
  if (event.kind === "text") return event.text;
  if (event.kind === "tool_start") return `正在使用 ${event.name}`;
  if (event.kind === "tool_result") return `${event.name} ${event.ok ? "执行成功" : "执行失败"}${event.output ? `：${event.output}` : ""}`;
  if (event.kind === "candidate_complete") return "Agent 已结束，正在核验真实输出";
  if (event.kind === "error") return `${event.code}：${event.message}`;
  if (event.kind === "final") return event.status === "completed" ? `任务完成，已核验 ${event.outputs.length} 个输出文件` : `任务失败：${event.reason}`;
  return "";
}

function readableBytes(value: number | null) {
  const bytes = value || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function WorkbenchPage() {
  const router = useRouter();
  const [needsLogin, setNeedsLogin] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [newName, setNewName] = useState("");
  const [task, setTask] = useState("");
  const [events, setEvents] = useState<WorkbenchEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const api = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, { ...init, cache: "no-store" });
    if (response.status === 401) setNeedsLogin(true);
    return response;
  }, []);

  const loadProjects = useCallback(async () => {
    const response = await api("/api/workbench/projects");
    if (!response.ok) {
      if (response.status !== 401) setError((await response.json().catch(() => ({}))).error || "项目列表加载失败");
      return;
    }
    const body = await response.json();
    setNeedsLogin(false);
    setProjects(body.projects || []);
    setSelectedId((current) => current || body.projects?.[0]?.id || "");
  }, [api]);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) { setDetail(null); return; }
    const response = await api(`/api/workbench/projects/${encodeURIComponent(id)}`);
    if (!response.ok) {
      setDetail(null);
      setError((await response.json().catch(() => ({}))).error || "项目状态加载失败");
      return;
    }
    setDetail(await response.json());
  }, [api]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);
  useEffect(() => { void loadDetail(selectedId); }, [loadDetail, selectedId]);

  // 未登录：跳转到独立登录页
  useEffect(() => {
    if (needsLogin) router.replace("/login");
  }, [needsLogin, router]);

  if (needsLogin) return (
    <main className="workbench-login">
      <p className="auth-hint">正在跳转到登录页…</p>
    </main>
  );

  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    if (!newName.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const response = await api("/api/workbench/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: newName }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "项目创建失败");
      setNewName("");
      await loadProjects();
      setSelectedId(body.project.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "项目创建失败"); }
    finally { setBusy(false); }
  }

  async function uploadFiles(files: FileList | null) {
    if (!selectedId || !files?.length || busy) return;
    setBusy(true); setError("");
    try {
      const form = new FormData();
      Array.from(files).forEach((file) => form.append("files", file));
      const response = await api(`/api/workbench/projects/${encodeURIComponent(selectedId)}/files`, { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "文件上传失败");
      await loadDetail(selectedId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "文件上传失败"); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  async function runTask(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedId || !task.trim() || busy) return;
    setBusy(true); setError(""); setEvents([]);
    try {
      const response = await api(`/api/workbench/projects/${encodeURIComponent(selectedId)}/runs`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task, requiresTests: true })
      });
      if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({}))).error || "任务启动失败");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const item = await reader.read();
        buffer += decoder.decode(item.value, { stream: !item.done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) if (line.trim()) {
          const parsed = JSON.parse(line) as WorkbenchEvent;
          setEvents((current) => [...current, parsed]);
        }
        if (item.done) break;
      }
      await loadDetail(selectedId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "任务执行失败"); }
    finally { setBusy(false); }
  }

  async function stopTask() {
    if (!selectedId) return;
    await api(`/api/workbench/projects/${encodeURIComponent(selectedId)}/interrupt`, { method: "POST" });
  }

  const finalEvent = useMemo(() => events.findLast((event) => event.kind === "final"), [events]);
  const persistedRun = !events.length && detail?.latestRun ? detail.latestRun : null;

  return (
    <main className="workbench-shell">
      <header className="workbench-header">
        <div><span className="eyebrow">GO AI</span><h1>云端项目智能体</h1></div>
        <div className={`runtime-badge ${error ? "offline" : ""}`}><span />{error ? "需要处理" : busy ? "正在执行" : "工作台就绪"}</div>
      </header>

      {error && <div className="workbench-alert"><span>{error}</span><button onClick={() => setError("")}>关闭</button></div>}

      <div className="workbench-grid">
        <aside className="project-panel panel-card">
          <div className="panel-title"><div><span>PROJECTS</span><h2>项目</h2></div><b>{projects.length}</b></div>
          <form className="project-create" onSubmit={createProject}>
            <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="新项目名称" />
            <button disabled={busy || !newName.trim()}>创建</button>
          </form>
          <div className="project-list">
            {projects.map((project) => <button key={project.id} className={project.id === selectedId ? "active" : ""} onClick={() => setSelectedId(project.id)}>
              <span className="project-dot" /><span><strong>{project.name}</strong><small>{new Date(project.updatedAt).toLocaleString()}</small></span>
            </button>)}
            {!projects.length && <p className="empty-copy">创建第一个项目后，沙盒和文件会持续保留。</p>}
          </div>
        </aside>

        <section className="task-panel panel-card">
          <div className="panel-title"><div><span>EXECUTION</span><h2>{detail?.project.name || "任务执行"}</h2></div>{detail && <b>持续沙盒</b>}</div>
          <form className="task-composer" onSubmit={runTask}>
            <textarea value={task} onChange={(event) => setTask(event.target.value)} disabled={!detail || busy} placeholder={detail ? "说明要完成的目标，例如：修改 input/index.html 的背景并运行检查，返回真实文件" : "先创建或选择一个项目"} />
            <div className="composer-actions">
              <span>执行后必须产生 outputs/ 真实文件</span>
              {busy ? <button type="button" className="stop" onClick={stopTask}>停止任务</button> : <button type="submit" disabled={!detail || !task.trim()}>运行任务</button>}
            </div>
          </form>
          <div className="run-timeline">
            {!events.length && !persistedRun && <div className="empty-run"><span>01</span><h3>等待任务</h3><p>Agent 会在隔离沙盒中读取、编辑、运行和验证项目。</p></div>}
            {!events.length && persistedRun && <div className="persisted-run"><small>上次任务 · {new Date(persistedRun.createdAt).toLocaleString()}</small><p>{persistedRun.task}</p><div className={`final-state ${persistedRun.finalStatus}`}>{persistedRun.finalStatus === "completed" ? `上次任务完成，已核验 ${persistedRun.outputs.length} 个输出文件` : `上次任务失败：${persistedRun.reason}`}</div></div>}
            {events.map((event, index) => <article key={`${index}-${event.kind}`} className={`run-event ${event.kind} ${event.kind === "tool_result" && !event.ok ? "failed" : ""}`}>
              <i>{event.kind === "tool_start" || event.kind === "tool_result" ? "⌘" : event.kind === "final" ? "✓" : "·"}</i>
              <div><small>{event.kind.replaceAll("_", " ")}</small><p>{eventLabel(event)}</p></div>
            </article>)}
          </div>
          {finalEvent?.kind === "final"
            ? <div className={`final-state ${finalEvent.status}`}>{eventLabel(finalEvent)}</div>
            : !events.length && persistedRun && <div className={`final-state ${persistedRun.finalStatus}`}>{persistedRun.finalStatus === "completed" ? `上次任务完成，已核验 ${persistedRun.outputs.length} 个输出文件` : `上次任务失败：${persistedRun.reason}`}</div>}
        </section>

        <aside className="files-panel panel-card">
          <div className="panel-title"><div><span>WORKSPACE</span><h2>文件</h2></div><button className="quiet" onClick={() => void loadDetail(selectedId)} disabled={!selectedId}>刷新</button></div>
          <input ref={fileInput} type="file" multiple hidden onChange={(event) => void uploadFiles(event.target.files)} />
          <button className="upload-zone" disabled={!detail || busy} onClick={() => fileInput.current?.click()}><span>＋</span><strong>上传项目文件</strong><small>文件会直接进入同一沙盒</small></button>
          <div className="file-group"><h3>输入文件 <b>{detail?.input.length || 0}</b></h3>
            {detail?.input.map((file) => <div className="file-row" key={file.name}><span>IN</span><div><strong>{file.name}</strong><small>{readableBytes(file.size_bytes)}</small></div></div>)}
            {!detail?.input.length && <p className="empty-copy">还没有输入文件</p>}
          </div>
          <div className="file-group outputs"><h3>可下载输出 <b>{detail?.outputs.length || 0}</b></h3>
            {detail?.outputs.map((file) => <a className="file-row" key={file.name} href={`/api/workbench/projects/${encodeURIComponent(selectedId)}/outputs/${encodeURIComponent(file.name)}`}>
              <span>OUT</span><div><strong>{file.name}</strong><small>{readableBytes(file.size_bytes)} · 下载</small></div>
            </a>)}
            {!detail?.outputs.length && <p className="empty-copy">任务通过输出核验后显示在这里</p>}
          </div>
        </aside>
      </div>
    </main>
  );
}
