"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import TopNav from "../../components/TopNav";
import { readableBytes } from "../tasks/status-meta";

type FileItem = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  source: string;
  created_at: string;
  task_id: string | null;
  task_title: string | null;
  downloadUrl: string;
};

export default function FilesPage() {
  const router = useRouter();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/files?limit=200", { cache: "no-store" });
    if (response.status === 401) { setNeedsLogin(true); return; }
    if (!response.ok) { setError("文件列表加载失败"); return; }
    const body = await response.json();
    setFiles(Array.isArray(body.files) ? body.files : []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (needsLogin) router.replace("/login"); }, [needsLogin, router]);

  return (
    <main className="home-shell">
      <TopNav />
      <section className="tasks-section">
        <header className="tasks-header">
          <div>
            <h1>文件</h1>
            <p>上传过的材料与任务产物，统一在这里下载。</p>
          </div>
          <a href="/" className="new-task-btn">＋ 上传并开始任务</a>
        </header>

        {error && <div className="workbench-alert"><span>{error}</span><button onClick={() => setError("")}>关闭</button></div>}

        {loading ? <p className="empty-copy">加载中…</p> : files.length === 0 ? (
          <div className="tasks-empty">
            <span>01</span>
            <h3>还没有文件</h3>
            <p>在首页发起任务时上传材料，或直接上传文件。</p>
          </div>
        ) : (
          <div className="files-table-wrap">
            <table className="files-table">
              <thead>
                <tr><th>文件名</th><th>大小</th><th>来源</th><th>所属任务</th><th>时间</th><th></th></tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.id}>
                    <td className="files-name">{file.filename}</td>
                    <td>{readableBytes(file.size)}</td>
                    <td><span className={`src-chip ${file.source}`}>{file.source}</span></td>
                    <td>{file.task_id ? <a href={`/tasks/${file.task_id}`} className="quiet-link">{file.task_title || "任务"}</a> : <span className="muted-text">—</span>}</td>
                    <td>{new Date(file.created_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                    <td><a href={file.downloadUrl} className="file-dl">下载 ↓</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
