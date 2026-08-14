"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import TopNav from "../components/TopNav";

/** 首页 = 任务启动器（PRD §7/§83）：大输入框 + 文件上传 + 快捷入口，创建即入队。 */

const QUICK_ENTRIES = [
  { label: "研究一个问题", prompt: "帮我调研一下：\n1. 现状与关键事实\n2. 各方观点与证据\n3. 结论与建议" },
  { label: "分析文件", prompt: "分析我上传的文件，提取关键信息并总结要点" },
  { label: "写文档", prompt: "根据材料写一份结构清晰的文档" },
  { label: "做表格", prompt: "把材料整理成一份 Excel 表格，包含必要的列与数据" },
  { label: "做 PPT", prompt: "把材料做成一份演示文稿（PPT），结构清晰、要点突出" },
  { label: "做网页", prompt: "把材料做成一个移动端优先的信息网页" },
  { label: "写程序", prompt: "实现一个程序：\n1. 说明输入与输出\n2. 编写并验证代码" }
];

export default function HomePage() {
  const router = useRouter();
  const [goal, setGoal] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  // 未登录检测：任何 401 跳登录页
  const checkAuth = useCallback((status: number) => {
    if (status === 401) router.replace("/login");
  }, [router]);

  useEffect(() => {
    void fetch("/api/tasks?limit=1", { cache: "no-store" })
      .then((response) => checkAuth(response.status))
      .catch(() => {});
  }, [checkAuth]);

  function pickFiles(list: FileList | null) {
    if (!list) return;
    const picked = Array.from(list).slice(0, 20 - files.length);
    setFiles((current) => [...current, ...picked]);
    if (fileInput.current) fileInput.current.value = "";
  }

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, i) => i !== index));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!goal.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("goal", goal.trim());
      files.forEach((file) => form.append("files", file));
      const response = await fetch("/api/tasks", { method: "POST", body: form, cache: "no-store" });
      checkAuth(response.status);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "任务创建失败");
      router.push(`/tasks/${body.task.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "任务创建失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="home-shell">
      <TopNav />

      <section className="launcher">
        <h1>今天想让 AI 帮你做什么？</h1>
        <p className="launcher-sub">描述目标、上传材料，系统会规划并后台执行，完成后给你文件。</p>

        <form className="launcher-form" onSubmit={submit}>
          <textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="例如：分析这些资料，给我做一个总结，整理一份 Excel，做一个 PPT"
            rows={4}
          />
          <div className="launcher-bar">
            <div className="launcher-attach">
              <input ref={fileInput} type="file" multiple hidden onChange={(event) => pickFiles(event.target.files)} />
              <button type="button" className="attach-btn" onClick={() => fileInput.current?.click()} disabled={busy}>＋ 添加文件</button>
              {files.map((file, index) => (
                <span className="file-chip" key={`${file.name}-${index}`}>
                  {file.name}
                  <button type="button" onClick={() => removeFile(index)}>×</button>
                </span>
              ))}
            </div>
            <button type="submit" className="launcher-go" disabled={busy || !goal.trim()}>
              {busy ? "创建中…" : "开始任务 →"}
            </button>
          </div>
          {error && <p className="launcher-error">{error}</p>}
        </form>

        <div className="quick-entries">
          {QUICK_ENTRIES.map((entry) => (
            <button key={entry.label} onClick={() => setGoal(entry.prompt)}>
              <strong>{entry.label}</strong><small>直接开始，也可先改描述</small>
            </button>
          ))}
        </div>

        <p className="launcher-note">任务在后台持续执行，关闭页面也不中断；完成后可随时回来查看和下载产物。</p>
      </section>
    </main>
  );
}
