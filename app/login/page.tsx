"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "login" | "register";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const checkSession = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/me", { cache: "no-store" });
      if (response.ok) router.replace("/");
    } catch { /* 网络失败留在登录页 */ }
  }, [router]);

  useEffect(() => { void checkSession(); }, [checkSession]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const url = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body = mode === "login"
        ? { email, password }
        : { email, password, displayName, inviteCode };
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || (mode === "login" ? "登录失败" : "注册失败"));
      router.replace("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="workbench-login">
      <form className="workbench-login-card auth-card" onSubmit={submit}>
        <span className="eyebrow">GO AI · CLOUD WORKSPACE</span>
        <h1>{mode === "login" ? "登录工作台" : "创建账户"}</h1>
        <p>{mode === "login" ? "登录后继续你的任务与成果。" : "注册后即可开始向 AI 安排工作。"}</p>

        <div className="auth-tabs" role="tablist">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setError(""); }}>登录</button>
          <button type="button" className={mode === "register" ? "active" : ""} onClick={() => { setMode("register"); setError(""); }}>注册</button>
        </div>

        {mode === "register" && (
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="昵称（选填）" maxLength={32} />
        )}
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="邮箱" autoComplete="email" autoFocus required />
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码（至少 8 位）" autoComplete={mode === "login" ? "current-password" : "new-password"} required />
        {mode === "register" && (
          <input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} placeholder="邀请码" autoComplete="off" />
        )}

        <button type="submit" disabled={busy || !email || !password}>{busy ? "请稍候…" : mode === "login" ? "登录" : "注册并进入"}</button>
        {error && <p className="workbench-error">{error}</p>}
        <p className="auth-hint">{mode === "register" ? "邀请码与部署时的访问密码一致" : "还没有账户？切换到“注册”创建。"}</p>
      </form>
    </main>
  );
}
