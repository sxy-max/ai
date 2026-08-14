"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import TopNav from "../../components/TopNav";

type ProjectItem = { id: string; name: string; updatedAt: string };

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/workbench/projects", { cache: "no-store" });
    if (response.status === 401) { setNeedsLogin(true); return; }
    if (!response.ok) { setError("项目列表加载失败"); return; }
    const body = await response.json();
    setProjects(Array.isArray(body.projects) ? body.projects : []);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (needsLogin) router.replace("/login"); }, [needsLogin, router]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/workbench/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
        cache: "no-store"
      });
      if (response.status === 401) { setNeedsLogin(true); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "创建失败");
      setName("");
      router.push("/workbench");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="home-shell">
      <TopNav />
      <section className="tasks-section">
        <header className="tasks-header">
          <div>
            <h1>项目</h1>
            <p>持续保留的云端项目工作区（沙盒 + 文件 + 任务历史）。</p>
          </div>
        </header>

        {error && <div className="workbench-alert"><span>{error}</span><button onClick={() => setError("")}>关闭</button></div>}

        <form className="project-create" onSubmit={create}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="新项目名称（如：我的 AI 产品）" />
          <button disabled={busy || !name.trim()}>{busy ? "创建中…" : "创建项目"}</button>
        </form>

        <div className="task-list" style={{ marginTop: 16 }}>
          {projects.length === 0 && <p className="empty-copy">创建第一个项目后，沙盒和文件会持续保留。</p>}
          {projects.map((project) => (
            <a key={project.id} href="/workbench" className="task-card">
              <div className="task-card-head">
                <span className="status-badge running">项目</span>
                <small>更新于 {new Date(project.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
              </div>
              <h3>{project.name}</h3>
              <p className="task-card-goal">进入工作区查看文件与任务历史 →</p>
            </a>
          ))}
        </div>
      </section>
    </main>
  );
}
