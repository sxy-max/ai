"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import AppShell from "../../../components/AppShell";
import { readableBytes } from "../../tasks/status-meta";

type ProjectArtifact = { id: string; name: string; type: string; version: number; size: number; createdAt: string; downloadUrl: string };
type ProjectTask = { id: string; title: string; goal: string; status: string; progress: number | null; result_summary: string | null; created_at: string };
type WorkspaceFile = { name: string; path: string; dir: boolean; size: number; modified: number; artifactName?: string };

type ProjectDetail = {
  project: { id: string; name: string; description: string; created_at: string };
  artifacts: ProjectArtifact[];
  tasks: ProjectTask[];
  files: WorkspaceFile[];
};

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (response.status === 401) { router.replace("/login"); return; }
    if (!response.ok) { setError("项目不存在或无权访问"); return; }
    setDetail(await response.json());
  }, [id, router]);

  useEffect(() => { void load(); }, [load]);

  if (error) {
    return (
      <main className="home-shell">
        <AppShell title="项目" backTo="/projects" />
        <section className="tasks-section">
          <div className="workbench-alert"><span>{error}</span><a href="/projects" className="quiet-link">← 返回项目列表</a></div>
        </section>
      </main>
    );
  }

  // 产物按名字分组显示版本序列（report v1 / v2 / v3）
  const versionGroups = new Map<string, ProjectArtifact[]>();
  for (const a of detail?.artifacts ?? []) {
    const list = versionGroups.get(a.name) || [];
    list.push(a);
    versionGroups.set(a.name, list);
  }

  return (
    <main className="home-shell">
      <AppShell title="项目" backTo="/projects" />
      <section className="tasks-section">
        {!detail ? (
          <p className="empty-copy">加载中…</p>
        ) : (
          <>
            <header className="tasks-header">
              <div>
                <a href="/projects" className="back-link">← 项目列表</a>
                <h1>{detail.project.name}</h1>
                <p>项目 workspace：多轮任务共享 · 创建于 {new Date(detail.project.created_at).toLocaleString("zh-CN")}</p>
              </div>
              <a href="/" className="new-task-btn">发起任务 →</a>
            </header>

            <h3 className="detail-section-title">产物历史（版本化）</h3>
            {!versionGroups.size ? (
              <p className="empty-copy">还没有产物。关联到本项目的任务完成后，产物（含各版本）会出现在这里。</p>
            ) : (
              <div className="artifact-grid">
                {[...versionGroups.entries()].map(([name, versions]) => (
                  <div key={name} className="artifact-card" data-testid="artifact-history">
                    <div className="artifact-icon">{versions[0].type.slice(0, 3).toUpperCase()}</div>
                    <div>
                      <strong>{name}.{versions[0].type === "markdown" ? "md" : versions[0].type}</strong>
                      <small>共 {versions.length} 个版本 · {readableBytes(versions[versions.length - 1].size)}</small>
                      <div className="version-row">
                        {versions.map((v) => (
                          <a key={v.id} href={`/artifacts/${v.id}/viewer`} className="version-chip" title={`${v.type} v${v.version} · ${new Date(v.createdAt).toLocaleString("zh-CN")}`}>
                            v{v.version}
                          </a>
                        ))}
                      </div>
                    </div>
                    <a href={versions[versions.length - 1].downloadUrl} className="quiet-link">下载 ↓</a>
                  </div>
                ))}
              </div>
            )}

            <h3 className="detail-section-title">Workspace 文件</h3>
            {!detail.files.length ? (
              <p className="empty-copy">workspace 尚未创建（首个关联任务运行时生成）。</p>
            ) : (
              <div className="project-files">
                {detail.files.map((f) => (
                  <div key={f.path} className={`project-file-row ${f.dir ? "dir" : ""}`}>
                    <span className="file-icon">{f.dir ? "📁" : "📄"}</span>
                    <span className="file-path">{f.path}</span>
                    <span className="file-meta">{f.dir ? "" : readableBytes(f.size)}</span>
                  </div>
                ))}
              </div>
            )}

            <h3 className="detail-section-title">任务</h3>
            {!detail.tasks.length ? (
              <p className="empty-copy">暂无任务。从首页发起任务时可选择本项目。</p>
            ) : (
              <div className="task-list">
                {detail.tasks.map((t) => (
                  <a key={t.id} href={`/tasks/${t.id}`} className="task-row">
                    <div>
                      <strong>{t.title}</strong>
                      <small>{t.goal?.slice(0, 120)}</small>
                    </div>
                    <span className={`status-chip status-${t.status}`}>{t.status}</span>
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
