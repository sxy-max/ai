"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import TopNav from "../../../components/TopNav";
import { readableBytes } from "../../tasks/status-meta";

type FileEntry = { name: string; is_dir: boolean; size_bytes: number | null };

type ProjectDetail = {
  project: { id: string; name: string; ownerId: string; createdAt: string; updatedAt: string };
  status: unknown;
  input: FileEntry[];
  outputs: FileEntry[];
  latestRun: { task: string; finalStatus: string; reason: string | null; createdAt: string } | null;
};

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/workbench/projects/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (response.status === 401) { setNeedsLogin(true); return; }
    if (!response.ok) { setError("项目不存在或无权访问"); return; }
    setDetail(await response.json());
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (needsLogin) router.replace("/login"); }, [needsLogin, router]);

  return (
    <main className="home-shell">
      <TopNav />
      <section className="tasks-section">
        {error ? (
          <div className="workbench-alert"><span>{error}</span><a href="/projects" className="quiet-link">← 返回项目列表</a></div>
        ) : !detail ? (
          <p className="empty-copy">加载中…</p>
        ) : (
          <>
            <header className="tasks-header">
              <div>
                <a href="/projects" className="back-link">← 项目列表</a>
                <h1>{detail.project.name}</h1>
                <p>持续沙盒 · 创建于 {new Date(detail.project.createdAt).toLocaleString("zh-CN")}</p>
              </div>
              <a href="/workbench" className="new-task-btn">进入工作区 →</a>
            </header>

            {detail.latestRun && (
              <div className={`final-state ${detail.latestRun.finalStatus}`}>
                <small>上次任务 · {new Date(detail.latestRun.createdAt).toLocaleString("zh-CN")}</small>
                <p>{detail.latestRun.task}</p>
                <div>{detail.latestRun.finalStatus === "completed" ? "上次任务完成，输出文件可下载" : `上次任务失败：${detail.latestRun.reason || "未知原因"}`}</div>
              </div>
            )}

            <div className="project-detail-grid">
              <section className="detail-pane side shown">
                <div className="panel-title"><div><span>INPUT</span><h2>输入文件</h2></div><b>{detail.input.length}</b></div>
                {detail.input.map((file) => (
                  <div className="file-row" key={file.name}><span>IN</span><div><strong>{file.name}</strong><small>{readableBytes(file.size_bytes)}</small></div></div>
                ))}
                {!detail.input.length && <p className="empty-copy">还没有输入文件</p>}
              </section>
              <section className="detail-pane side shown">
                <div className="panel-title"><div><span>OUTPUTS</span><h2>可下载输出</h2></div><b>{detail.outputs.length}</b></div>
                {detail.outputs.map((file) => (
                  <a className="file-row" key={file.name} href={`/api/workbench/projects/${encodeURIComponent(id)}/outputs/${encodeURIComponent(file.name)}`}>
                    <span>OUT</span><div><strong>{file.name}</strong><small>{readableBytes(file.size_bytes)} · 下载</small></div>
                  </a>
                ))}
                {!detail.outputs.length && <p className="empty-copy">任务通过输出核验后显示在这里</p>}
              </section>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
