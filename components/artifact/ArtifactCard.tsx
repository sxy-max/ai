"use client";

import { useEffect, useState } from "react";
import { artifactDisplayKind, fmtSize } from "../../lib/job/ui";

// Scripts and forms make an artifact usable, while the missing allow-same-origin
// keeps untrusted HTML in an opaque origin that cannot access the app.
const HTML_PREVIEW_SANDBOX = "allow-scripts allow-forms allow-popups";

export type ClientArtifactCard = {
  id: string;
  name: string;
  mime: string;
  size: number;
  downloadUrl: string;
  kind?: string;
  status?: string;
};

/**
 * Artifact Card：点击 = 打开结果（默认进入 Dedicated Viewer，不是文件详情）。
 * - html：卡片内含小预览（即时可看），标题/全屏按钮 → Full-Viewport Viewer
 * - image / markdown / 其他：整卡可点击 → Viewer（渲染或预览）
 * - 下载保留为卡内次按钮，不抢「打开结果」的视觉权重
 */
export default function ArtifactCard({ a }: { a: ClientArtifactCard }) {
  if (a.status === "pending") return <PendingCard name={a.name} />;
  const display = artifactDisplayKind(a.name, a.mime);
  if (display === "html") return <HtmlPreview a={a} />;
  if (display === "image") return <ImageCard a={a} />;
  return <FileCard a={a} />;
}

const viewerHref = (a: ClientArtifactCard) => `/artifacts/${encodeURIComponent(a.id)}/viewer`;

function PendingCard({ name }: { name: string }) {
  return (
    <div className="artifact-card artifact-pending" data-testid="artifact-card">
      <div className="artifact-icon">⏳</div>
      <div className="artifact-body">
        <div className="artifact-name">{name}</div>
        <div className="artifact-meta">生成中…</div>
      </div>
    </div>
  );
}

function HtmlPreview({ a }: { a: ClientArtifactCard }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | undefined;
    fetch(a.downloadUrl)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error("load failed"))))
      // Artifact HTML is UTF-8 text. Set the blob charset explicitly so pages without a
      // <meta charset> do not fall back to Windows-1252 inside an opaque iframe origin.
      .then((text) => new Blob([text], { type: "text/html;charset=utf-8" }))
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (alive) setUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [a.downloadUrl]);
  if (failed) return <FileCard a={a} />;
  return (
    <div className="artifact-card artifact-html" data-testid="artifact-card">
      <div className="artifact-html-head">
        <a href={viewerHref(a)} className="artifact-name" title="打开网页预览">{a.name}</a>
        <a href={viewerHref(a)} className="artifact-fullscreen">⛶ 全屏</a>
      </div>
      {url ? (
        <div className="artifact-html-preview-wrap">
          <iframe className="artifact-html-frame" sandbox={HTML_PREVIEW_SANDBOX} src={url} title={a.name} />
          <a className="artifact-html-open-hit" href={viewerHref(a)} aria-label={`打开 ${a.name}`} />
        </div>
      ) : (
        <div className="artifact-meta">加载预览中…</div>
      )}
    </div>
  );
}

function ImageCard({ a }: { a: ClientArtifactCard }) {
  return (
    <a className="artifact-card artifact-image" href={viewerHref(a)} data-testid="artifact-card" title="打开查看">
      <img className="artifact-thumb" src={a.downloadUrl} alt={a.name} loading="lazy" />
      <div className="artifact-body">
        <div className="artifact-name">{a.name}</div>
        <div className="artifact-meta">打开查看 →</div>
      </div>
    </a>
  );
}

function FileCard({ a }: { a: ClientArtifactCard }) {
  const [expired, setExpired] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const download = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (downloading || expired) return;
    setDownloading(true);
    try {
      const res = await fetch(a.downloadUrl);
      if (!res.ok) { setExpired(true); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = a.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch {
      setExpired(true);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <a className="artifact-card" href={viewerHref(a)} data-testid="artifact-card" title="打开查看">
      <div className="artifact-icon">📄</div>
      <div className="artifact-body">
        <div className="artifact-name">{a.name}</div>
        <div className="artifact-meta">{(a.mime.split("/")[1] || a.mime).toUpperCase()} · {fmtSize(a.size)} · 打开 →</div>
      </div>
      {expired
        ? <span className="artifact-expired">文件已过期</span>
        : <button className="artifact-dl" onClick={download} disabled={downloading}>{downloading ? "下载中…" : "下载"}</button>}
    </a>
  );
}
