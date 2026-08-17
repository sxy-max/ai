"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AppShell from "../../components/AppShell";
import PersonalizationPanel from "../../components/personalization/Panel";
import { defaultProfile, loadProfile, saveProfile, type PersonalizationProfile } from "../../lib/personalization";

const SETTINGS_KEY = "go-ai-settings-v3";

type SearchMode = "off" | "auto" | "on";
type ContextMode = "compact" | "balanced" | "full";
type ReasoningEffort = "off" | "auto" | "low" | "medium" | "high";
type ThemeMode = "system" | "light" | "dark";

export default function SettingsPage() {
  const router = useRouter();
  const [searchMode, setSearchMode] = useState<SearchMode>("auto");
  const [contextMode, setContextMode] = useState<ContextMode>("balanced");
  const [temperature, setTemperature] = useState(0.7);
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("auto");
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [profile, setProfile] = useState<PersonalizationProfile>(defaultProfile);
  const [needsLogin, setNeedsLogin] = useState(false);

  useEffect(() => {
    void fetch("/api/auth/me", { cache: "no-store" })
      .then((response) => { if (response.status === 401) setNeedsLogin(true); })
      .catch(() => {});
  }, []);
  useEffect(() => { if (needsLogin) router.replace("/login"); }, [needsLogin, router]);

  // 读取/写入与聊天页共享的 localStorage 配置
  useEffect(() => {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      try {
        const s = JSON.parse(raw);
        if (["off", "auto", "on"].includes(s.searchMode)) setSearchMode(s.searchMode);
        if (["compact", "balanced", "full"].includes(s.contextMode)) setContextMode(s.contextMode);
        if (typeof s.temperature === "number") setTemperature(s.temperature);
        if (s.maxOutputTokens != null) setMaxOutputTokens(String(s.maxOutputTokens || ""));
        if (["off", "auto", "low", "medium", "high"].includes(s.reasoningEffort)) setReasoningEffort(s.reasoningEffort);
        if (["system", "light", "dark"].includes(s.theme)) setTheme(s.theme);
      } catch {}
    }
    setProfile(loadProfile());
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ searchMode, contextMode, temperature, maxOutputTokens, reasoningEffort, theme }));
    } catch {}
  }, [searchMode, contextMode, temperature, maxOutputTokens, reasoningEffort, theme]);

  useEffect(() => { saveProfile(profile); }, [profile]);

  // 主题应用（与聊天页一致）
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const resolved = theme === "system" ? (mq.matches ? "light" : "dark") : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  return (
    <main className="home-shell">
      <AppShell title="设置" backTo="/" />
      <section className="settings-page">
        <header className="tasks-header">
          <div>
            <h1>设置</h1>
            <p>与聊天页共享的本地配置：主题、联网、上下文、推理参数与个性化。</p>
          </div>
        </header>

        <div className="settings-card">
          <h2>聊天参数</h2>
          <div className="settings-grid">
            <label>主题
              <select value={theme} onChange={(e) => setTheme(e.target.value as ThemeMode)}>
                <option value="system">自动</option><option value="light">浅色</option><option value="dark">深色</option>
              </select>
            </label>
            <label>联网
              <select value={searchMode} onChange={(e) => setSearchMode(e.target.value as SearchMode)}>
                <option value="auto">自动</option><option value="on">开启</option><option value="off">关闭</option>
              </select>
            </label>
            <label>上下文
              <select value={contextMode} onChange={(e) => setContextMode(e.target.value as ContextMode)}>
                <option value="compact">压缩</option><option value="balanced">平衡</option><option value="full">尽量完整</option>
              </select>
            </label>
            <label>Reasoning
              <select value={reasoningEffort} onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffort)}>
                <option value="auto">自动</option><option value="off">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option>
              </select>
            </label>
            <label>温度
              <input type="number" min="0" max="2" step="0.1" value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} />
            </label>
            <label>最大输出
              <input inputMode="numeric" value={maxOutputTokens} onChange={(e) => setMaxOutputTokens(e.target.value.replace(/\D/g, ""))} placeholder="默认" />
            </label>
          </div>
          <p className="settings-note">高级选项立即生效；具体模型不支持时会由服务端自动忽略。</p>
        </div>

        <div className="settings-card">
          <h2>个性化</h2>
          <p className="settings-note">记忆 · 回复风格 · 我的 Skills。按浏览器本地保存，注入聊天与文件任务。</p>
          <PersonalizationPanel profile={profile} onChange={setProfile} />
        </div>
      </section>
    </main>
  );
}
