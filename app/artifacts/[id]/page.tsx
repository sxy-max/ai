"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { readableBytes } from "../../tasks/status-meta";
import TopNav from "../../../components/TopNav";

type ArtifactMeta = {
  id: string;
  filename: string;
  kind: string;
  mime: string;
  size: number;
  status: string;
  createdAt: number;
  downloadUrl: string;
  taskId: string | null;
};

const TEXT_KINDS = new Set(["markdown", "text", "html", "csv", "json", "code"]);

export default function ArtifactPreviewPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [meta, setMeta] = useState<ArtifactMeta | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(params.id)}/meta`, { cache: "no-store" });
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok) { setError("产物不存在或已过期"); return; }
      const data = (await response.json()) as ArtifactMeta;
      if (cancelled) return;
      setMeta(data);
      if (TEXT_KINDS.has(data.kind) && data.size < 1024 * 1024) {
        const textResponse = await fetch(data.downloadUrl, { cache: "no-store" });
        if (textResponse.ok) {
          const text = await textResponse.text();
          if (!cancelled) setContent(text.slice(0, 200_000));
        }
      }
    })().catch(() => { if (!cancelled) setError("加载失败"); });
    return () => { cancelled = true; };
  }, [params.id, router]);

  if (!meta && !error) {
    return (
      <main className="home-shell">
        <TopNav />
        <section className="tasks-section"><p className="empty-copy">加载中…</p></section>
      </main>
    );
  }

  return (
    <main className="home-shell">
      <TopNav />
      <section className="artifact-preview">
        {error ? (
          <div className="workbench-alert"><span>{error}</span></div>
        ) : (
          <>
            <header className="artifact-preview-header">
              <div>
                <h1>{meta!.filename}</h1>
                <p>{meta!.kind} · {readableBytes(meta!.size)} · 创建于 {new Date(meta!.createdAt).toLocaleString("zh-CN")}</p>
              </div>
              <div className="artifact-actions">
                {meta!.taskId && <a href={`/tasks/${meta!.taskId}`} className="quiet-link">← 所属任务</a>}
                <a href={meta!.downloadUrl} className="new-task-btn">下载 ↓</a>
              </div>
            </header>
            {content !== null ? (
              meta!.kind === "html"
                ? <iframe className="artifact-frame" srcDoc={content} sandbox="" title="产物预览" />
                : <pre className="artifact-pre">{content}</pre>
            ) : (
              <div className="artifact-binary-note">该类型不支持内联预览，请下载后查看。</div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
