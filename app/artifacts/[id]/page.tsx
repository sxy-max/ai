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

type PreviewAsset = { type: string; mime: string; url?: string; content?: string };
type PreviewState = {
  type: string;
  html: string | null;
  metadata: Record<string, unknown>;
};

const TEXT_KINDS = new Set(["markdown", "text", "html", "csv", "json", "code"]);
// 走 Preview API（V1.4 WP17-18）：table/文本/png 页/文件树/页数元数据
const PREVIEW_KINDS = new Set(["xlsx", "docx", "pdf", "zip", "pptx", "image"]);

/** iframe srcDoc 骨架：预览 HTML（table/tree/img）带最小内联样式，保持沙箱。 */
function frameHtml(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#fff;color:#111}
.preview-table{border-collapse:collapse;width:100%;font-size:13px}
.preview-table th,.preview-table td{border:1px solid #ddd;padding:6px 10px;text-align:left}
.preview-table th{background:#f2f2f2}
.preview-tree{list-style:none;font-family:ui-monospace,Consolas,monospace;font-size:13px;padding:12px;margin:0;line-height:1.7}
.preview-image{max-width:100%;height:auto;display:block;margin:12px auto}
</style></head><body>${inner}</body></html>`;
}

export default function ArtifactPreviewPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [meta, setMeta] = useState<ArtifactMeta | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
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
      } else if (PREVIEW_KINDS.has(data.kind)) {
        const pv = await fetch(`/api/artifacts/${encodeURIComponent(params.id)}/preview`, { cache: "no-store" });
        if (pv.ok) {
          const pj = (await pv.json()) as { previewType: string; previewAssets: PreviewAsset[]; metadata: Record<string, unknown> };
          const asset = pj.previewAssets?.[0];
          let html = asset?.content ?? null;
          if (!html && asset?.url) {
            const ar = await fetch(asset.url, { cache: "no-store" });
            if (ar.ok) html = await ar.text();
          }
          if (!cancelled) setPreview({ type: pj.previewType, html, metadata: pj.metadata ?? {} });
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
            {preview ? (
              preview.type === "presentation" ? (
                <div className="artifact-binary-note">
                  幻灯片共 {String(preview.metadata.slideCount ?? "?")} 页；缩略图需服务端渲染，请下载后查看。
                </div>
              ) : preview.html ? (
                preview.type === "document" || preview.type === "text"
                  ? <pre className="artifact-pre">{preview.html}</pre>
                  : <iframe className="artifact-frame" srcDoc={frameHtml(preview.html)} sandbox="" title="产物预览" />
              ) : (
                <div className="artifact-binary-note">该类型暂无法生成预览，请下载后查看。</div>
              )
            ) : content !== null ? (
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
