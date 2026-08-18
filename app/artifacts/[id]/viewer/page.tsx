"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { readableBytes } from "../../../tasks/status-meta";
import RichContent from "../../../../components/rich/RichContent";

/**
 * Artifact Viewer：点击 Artifact 后的默认打开页。
 * - HTML / 网页产物：Full-Viewport Web Viewer（薄 Toolbar + iframe 占满剩余视口；
 *   sandbox="" 安全隔离保持不变，只是 iframe 从预览小窗变成主体）
 * - Markdown / 文本：统一 Rich Content 渲染（raw 仅作原文模式）
 * - 图片：全宽展示
 * - xlsx/docx/pdf/zip/pptx：接入现有 Preview API（table/text/tree/page），全宽展示
 * - 元信息 / 下载 / 所属任务 / 继续修改：全部进 Toolbar 的 More 菜单
 */

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

const TEXT_KINDS = new Set(["markdown", "text", "csv", "json", "code"]);
// 走 Preview API（V1.4 WP17-18）：table/文本/png 页/文件树/页数元数据
const PREVIEW_KINDS = new Set(["xlsx", "docx", "pdf", "zip", "pptx"]);
// 允许结果网页自身的交互，但不允许它获得与 Go AI 相同的 origin。
const HTML_VIEWER_SANDBOX = "allow-scripts allow-forms allow-popups";

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

export default function ArtifactViewerPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [meta, setMeta] = useState<ArtifactMeta | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<Record<string, unknown> | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");

  // Safari occasionally reports a stale 100dvh while its bottom chrome is
  // animating. Use the visual viewport only as a measured fallback.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const shell = document.querySelector<HTMLElement>(".viewer-shell");
      if (!shell) return;
      shell.style.height = `${Math.max(200, viewport.height)}px`;
      shell.style.maxHeight = `${Math.max(200, viewport.height)}px`;
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(params.id)}/meta`, { cache: "no-store" });
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok) { setError("产物不存在或已过期"); return; }
      const data = (await response.json()) as ArtifactMeta;
      if (cancelled) return;
      setMeta(data);

      if (data.kind === "html") {
        // HTML：blob URL 交给 iframe（全视口；opaque-origin sandbox 保持）
        try {
          const binary = await fetch(data.downloadUrl, { cache: "no-store" });
          if (binary.ok) {
            // Artifact HTML is UTF-8. The explicit charset protects pages that omit a
            // meta charset from the browser's legacy Windows-1252 fallback in blob URLs.
            const text = await binary.text();
            const blob = new Blob([text], { type: "text/html;charset=utf-8" });
            const objectUrl = URL.createObjectURL(blob);
            if (!cancelled) setBlobUrl(objectUrl);
            else URL.revokeObjectURL(objectUrl);
          }
        } catch {}
      } else if (data.kind === "image" || data.mime?.startsWith("image/")) {
        try {
          const binary = await fetch(data.downloadUrl, { cache: "no-store" });
          if (binary.ok) {
            const blob = await binary.blob();
            if (!cancelled) setBlobUrl(URL.createObjectURL(blob));
          }
        } catch {}
      } else if (TEXT_KINDS.has(data.kind) && data.size < 1024 * 1024) {
        const textResponse = await fetch(data.downloadUrl, { cache: "no-store" });
        if (textResponse.ok) {
          const text = await textResponse.text();
          if (!cancelled) setContent(text.slice(0, 400_000));
        }
      } else if (PREVIEW_KINDS.has(data.kind)) {
        // 现有 Preview API：table/text/tree/page → 全宽展示（不缩成小窗）
        const pv = await fetch(`/api/artifacts/${encodeURIComponent(params.id)}/preview`, { cache: "no-store" });
        if (pv.ok) {
          const pj = (await pv.json()) as { previewType: string; previewAssets: Array<{ type: string; mime: string; url?: string; content?: string }>; metadata: Record<string, unknown> };
          const asset = pj.previewAssets?.[0];
          let html = asset?.content ?? null;
          if (!html && asset?.url) {
            const ar = await fetch(asset.url, { cache: "no-store" });
            if (ar.ok) html = await ar.text();
          }
          if (!cancelled) {
            setPreviewMeta(pj.metadata ?? {});
            if (pj.previewType === "presentation") {
              // 无内联缩略图：提示 + 下载（不伪造能力）
              setPreviewHtml(null);
              setPreviewText(null);
            } else if (asset?.type === "text") {
              setPreviewText(html ?? "");
            } else if (html) {
              setPreviewHtml(html);
            }
          }
        }
      }
    })().catch(() => { if (!cancelled) setError("加载失败"); });
    return () => { cancelled = true; };
  }, [params.id, router]);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const back = () => {
    if (window.history.length > 1) window.history.back();
    else router.push("/tasks");
  };

  /** 「继续修改」：沿用 Task/Artifact lineage——回首页预填目标并自动带上本产物（客户端 blob 重传，走同一 Preflight 主链）。 */
  function continueEdit() {
    if (!meta) return;
    const goal = `继续修改产物「${meta.filename}」：请基于已有内容继续处理，输出更新后的文件。`;
    const q = new URLSearchParams({ goal, artifact: meta.id, artifactName: meta.filename }).toString();
    router.push(`/?${q}`);
  }

  if (error) {
    return (
      <main className="viewer-shell">
        <div className="viewer-toolbar"><button className="viewer-back" onClick={back}>‹</button><strong className="viewer-title">产物</strong></div>
        <div className="viewer-body viewer-note">{error}</div>
      </main>
    );
  }

  if (!meta) {
    return (
      <main className="viewer-shell">
        <div className="viewer-toolbar"><button className="viewer-back" onClick={back}>‹</button><strong className="viewer-title">产物</strong></div>
        <div className="viewer-body viewer-note">加载中…</div>
      </main>
    );
  }

  const isHtml = meta.kind === "html";
  const isImage = meta.kind === "image" || meta.mime?.startsWith("image/");
  const showRich = !isHtml && !isImage && content !== null;
  const showPreviewFrame = !isHtml && !isImage && content === null && previewHtml !== null;
  const showPreviewText = !isHtml && !isImage && content === null && previewText !== null;
  const showPptNote = previewMeta && previewMeta.format === "pptx";

  return (
    <main className="viewer-shell">
      {/* 极薄 Viewer Toolbar：Back + 简短文件名 + More（下载/信息/所属任务/继续修改） */}
      <div className="viewer-toolbar">
        <button className="viewer-back" onClick={back} aria-label="返回">‹</button>
        <strong className="viewer-title" title={meta.filename}>{meta.filename}</strong>
        <div className="viewer-more-wrap">
          <button className="viewer-more" onClick={() => setMore((m) => !m)} aria-label="更多操作">⋯</button>
          {more && (
            <div className="viewer-menu">
              <a href={meta.downloadUrl} download={meta.filename} className="viewer-menu-item" onClick={() => setMore(false)}>⬇ 下载</a>
              <button className="viewer-menu-item" onClick={() => setMore(false)}>{meta.kind} · {readableBytes(meta.size)} · {new Date(meta.createdAt).toLocaleString("zh-CN")}</button>
              {meta.taskId && <a href={`/tasks/${meta.taskId}`} className="viewer-menu-item" onClick={() => setMore(false)}>🗂 所属任务</a>}
              {!isHtml && !isImage && (content !== null || previewText !== null) && (
                <a href={meta.downloadUrl} download={meta.filename} className="viewer-menu-item" onClick={() => setMore(false)}>📄 查看源文件</a>
              )}
              <button className="viewer-menu-item" onClick={() => { setMore(false); continueEdit(); }}>↻ 继续修改</button>
            </div>
          )}
        </div>
      </div>

      <div className="viewer-body">
        {isHtml ? (
          blobUrl ? (
            <iframe
              className="viewer-iframe"
              src={blobUrl}
              sandbox={HTML_VIEWER_SANDBOX}
              title={meta.filename}
            />
          ) : (
            <div className="viewer-note">HTML 预览加载中…</div>
          )
        ) : isImage ? (
          <div className="viewer-image-wrap">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="viewer-image" src={blobUrl || meta.downloadUrl} alt={meta.filename} />
          </div>
        ) : showRich ? (
          <div className="viewer-rich">
            <RichContent content={content || ""} rawToggle copyButton />
          </div>
        ) : showPreviewFrame ? (
          <iframe className="viewer-iframe" srcDoc={frameHtml(previewHtml!)} sandbox="" title={`${meta.filename} 预览`} />
        ) : showPreviewText ? (
          <div className="viewer-rich">
            <RichContent content={previewText || ""} copyButton />
          </div>
        ) : showPptNote ? (
          <div className="viewer-note">
            <p>幻灯片共 {String(previewMeta.slideCount ?? "?")} 页；缩略图需服务端渲染，请下载后查看。</p>
            <a href={meta.downloadUrl} download={meta.filename} className="viewer-download">⬇ 下载 {meta.filename}</a>
          </div>
        ) : (
          <div className="viewer-note">
            <p>该类型不支持内联预览。</p>
            <a href={meta.downloadUrl} download={meta.filename} className="viewer-download">⬇ 下载 {meta.filename}</a>
          </div>
        )}
      </div>
    </main>
  );
}
