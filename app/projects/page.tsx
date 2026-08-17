"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AppShell from "../../components/AppShell";

type ProjectItem = {
  id: string; name: string; description: string; taskCount: number; artifactCount: number; updatedAt: string;
};

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectItem[] | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/projects", { cache: "no-store" });
    if (response.status === 401) { router.replace("/login"); return; }
    if (!response.ok) { setError("加载失败"); return; }
    const data = await response.json();
    setProjects(data.projects ?? []);
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!response.ok) { setError("创建失败"); return; }
      const data = await response.json();
      router.push(`/projects/${data.project.id}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="home-shell">
      <AppShell title="项目" backTo="/" />
      <section className="tasks-section">
        <header className="tasks-header">
          <div>
            <h1>项目</h1>
            <p>同一项目的多轮任务共享 workspace——不重复上传原材料，产物版本可追溯。</p>
          </div>
        </header>

        <div className="project-create-row">
          <input
            className="project-name-input"
            placeholder="新项目名称（如：大学物理课程材料）"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
            data-testid="project-name-input"
          />
          <button className="new-task-btn" onClick={() => void create()} disabled={creating || !name.trim()} data-testid="project-create-btn">创建项目</button>
        </div>

        {error && <div className="workbench-alert"><span>{error}</span></div>}

        {projects === null ? (
          <p className="empty-copy">加载中…</p>
        ) : !projects.length ? (
          <p className="empty-copy">还没有项目。创建一个项目后，任务可关联到项目并延续 workspace。</p>
        ) : (
          <div className="project-grid">
            {projects.map((p) => (
              <a key={p.id} href={`/projects/${p.id}`} className="project-card" data-testid="project-card">
                <strong>{p.name}</strong>
                {p.description && <small>{p.description}</small>}
                <small>{p.taskCount} 个任务 · {p.artifactCount} 个产物 · 更新于 {new Date(p.updatedAt).toLocaleString("zh-CN")}</small>
              </a>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
