"use client";

import { useEffect, useState } from "react";
import { artifactDisplayKind, fmtSize } from "../../lib/job/ui";

export type ClientArtifactCard = {
  id: string;
  name: string;
  mime: string;
  size: number;
  downloadUrl: string;
  kind?: string;
  status?: string;
};

/** 按 kind 路由预览：html 内联 iframe / image 缩略图 / 其余下载卡；pending 显示生成中。 */
export default function ArtifactCard({ a }: { a: ClientArtifactCard }) {
  if (a.status === "pending") return <PendingCard name={a.name} />;
  const display = artifactDisplayKind(a.name, a.mime);
  if (display === "html") return <HtmlPreview a={a} />;
  if (display === "image") return <ImageCard a={a} />;
  return <FileCard a={a} />;
}

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
    fetch(a.downloadUrl)
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error("load failed"))))
      .then((blob) => { if (alive) setUrl(URL.createObjectURL(blob)); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [a.downloadUrl]);
  if (failed) return <FileCard a={a} />;
  return (
    <div className="artifact-card artifact-html" data-testid="artifact-card">
      <div className="artifact-name">{a.name}</div>
      {url ? (
        <iframe className="artifact-html-frame" sandbox="" src={url} title={a.name} />
      ) : (
        <div className="artifact-meta">加载预览中…</div>
      )}
    </div>
  );
}

function ImageCard({ a }: { a: ClientArtifactCard }) {
  return (
    <div className="artifact-card artifact-image" data-testid="artifact-card">
      <img className="artifact-thumb" src={a.downloadUrl} alt={a.name} loading="lazy" />
      <div className="artifact-name">{a.name}</div>
    </div>
  );
}

function FileCard({ a }: { a: ClientArtifactCard }) {
  const [expired, setExpired] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
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
    <div className="artifact-card" data-testid="artifact-card">
      <div className="artifact-icon">📄</div>
      <div className="artifact-body">
        <div className="artifact-name">{a.name}</div>
        <div className="artifact-meta">{(a.mime.split("/")[1] || a.mime).toUpperCase()} · {fmtSize(a.size)}</div>
      </div>
      {expired
        ? <span className="artifact-expired">文件已过期</span>
        : <button className="artifact-dl" onClick={download} disabled={downloading}>{downloading ? "下载中…" : "下载"}</button>}
    </div>
  );
}
