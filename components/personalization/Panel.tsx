"use client";

import { useRef, useState } from "react";
import { parseSkillMarkdown, STYLE_PRESETS, type MemoryItem, type PersonalizationProfile, type SkillItem, type StyleMode } from "../../lib/personalization";

function uid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export default function PersonalizationPanel({
  profile,
  onChange,
}: {
  profile: PersonalizationProfile;
  onChange: (p: PersonalizationProfile) => void;
}) {
  const [newText, setNewText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const setMemory = (memory: MemoryItem[]) => onChange({ ...profile, memory });
  const setSkills = (skills: SkillItem[]) => onChange({ ...profile, skills });
  const addMemory = () => {
    const text = newText.trim();
    if (!text) return;
    setMemory([...profile.memory, { id: uid(), text, enabled: true }]);
    setNewText("");
  };
  const updateItem = (id: string, patch: Partial<MemoryItem>) =>
    setMemory(profile.memory.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  const removeItem = (id: string) => setMemory(profile.memory.filter((m) => m.id !== id));
  const disableAll = () => setMemory(profile.memory.map((m) => ({ ...m, enabled: false })));
  const startEdit = (m: MemoryItem) => {
    setEditingId(m.id);
    setEditText(m.text);
  };
  const saveEdit = () => {
    if (editingId) updateItem(editingId, { text: editText.trim() });
    setEditingId(null);
  };

  const setStyleMode = (mode: StyleMode) => onChange({ ...profile, style: { ...profile.style, mode } });
  const setCustomRules = (customRules: string) => onChange({ ...profile, style: { mode: "custom", customRules } });

  const importSkills = async (files: FileList | null) => {
    if (!files?.length) return;
    setImportMsg("");
    const added: SkillItem[] = [];
    for (const file of Array.from(files).slice(0, 10)) {
      const text = await file.text().catch(() => "");
      const parsed = parseSkillMarkdown(text, file.name);
      if (!parsed) continue;
      added.push({ id: uid(), name: parsed.name, description: parsed.description, content: parsed.content, enabled: true });
    }
    if (!added.length) {
      setImportMsg("无法解析该文件：需要 .md / .txt 且包含可读内容。");
      return;
    }
    setSkills([...added, ...profile.skills].slice(0, 40));
    setImportMsg(`已导入 ${added.length} 个 Skill（${added.map((s) => s.name).join("、")}）`);
    if (fileRef.current) fileRef.current.value = "";
  };

  const enabledCount = profile.memory.filter((m) => m.enabled).length;

  return (
    <div className="pz-panel">
      <section className="pz-section">
        <div className="pz-head">
          <h3>记忆</h3>
          <span className="pz-count">{enabledCount}/{profile.memory.length} 已启用{enabledCount > 0 ? " · 自动注入每轮对话" : ""}</span>
        </div>
        {profile.memory.length > 0 && <div className="pz-tools"><button className="pz-btn ghost" onClick={disableAll}>全部关闭</button></div>}
        <div className="pz-list">
          {profile.memory.length === 0 && <p className="pz-empty">还没有记忆。写一条关于你自己的信息，Go AI 会在后续对话中记住它。</p>}
          {profile.memory.map((m) => (
            <div className={`pz-item ${m.enabled ? "" : "off"}`} key={m.id}>
              <label className="pz-toggle">
                <input type="checkbox" checked={m.enabled} onChange={(e) => updateItem(m.id, { enabled: e.target.checked })} />
              </label>
              {editingId === m.id ? (
                <div className="pz-edit">
                  <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={2} autoFocus />
                  <div className="pz-edit-actions">
                    <button className="pz-btn" onClick={saveEdit}>保存</button>
                    <button className="pz-btn ghost" onClick={() => setEditingId(null)}>取消</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="pz-text" onClick={() => startEdit(m)}>{m.text}</div>
                  <div className="pz-item-actions">
                    <button className="pz-mini" onClick={() => startEdit(m)} title="编辑">✎</button>
                    <button className="pz-mini danger" onClick={() => removeItem(m.id)} title="删除">×</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="pz-add">
          <textarea value={newText} onChange={(e) => setNewText(e.target.value)} placeholder="例如：我叫小 Y，是一名前端工程师，工作语言是中文…" rows={2} />
          <button className="pz-btn" onClick={addMemory}>＋ 添加记忆</button>
        </div>
      </section>

      <section className="pz-section">
        <div className="pz-head"><h3>回复风格</h3><span className="pz-count">{STYLE_PRESETS[profile.style.mode].label}</span></div>
        <div className="pz-styles">
          {(Object.keys(STYLE_PRESETS) as StyleMode[]).map((mode) => (
            <button key={mode} className={`pz-style ${profile.style.mode === mode ? "active" : ""}`} onClick={() => setStyleMode(mode)}>
              <b>{STYLE_PRESETS[mode].label}</b>
              <span>{STYLE_PRESETS[mode].description}</span>
            </button>
          ))}
        </div>
        {profile.style.mode === "custom" && (
          <div className="pz-custom">
            <label>自定义回答规则<textarea value={profile.style.customRules || ""} onChange={(e) => setCustomRules(e.target.value)} rows={4} placeholder={"例如：\n先给结论\n减少废话\n技术问题提供实际步骤"} /></label>
          </div>
        )}
        <p className="pz-note">回复风格作为独立 personalization context 注入，安全规则永远优先于个人化偏好。</p>
      </section>

      <section className="pz-section">
        <div className="pz-head">
          <h3>我的 Skills</h3>
          <span className="pz-count">{profile.skills.filter((s) => s.enabled).length}/{profile.skills.length} 已启用 · 按当前任务自动选择</span>
        </div>
        <div className="pz-tools">
          <label className="pz-btn" style={{ cursor: "pointer" }}>导入 Skill<input ref={fileRef} type="file" accept=".md,.markdown,.txt" multiple hidden onChange={(e) => { void importSkills(e.target.files); }} /></label>
        </div>
        {importMsg && <p className="pz-note">{importMsg}</p>}
        <div className="pz-list">
          {profile.skills.length === 0 && <p className="pz-empty">还没有 Skill。导入一个 SKILL.md（支持 YAML frontmatter 的 name/description），Go AI 会在相关任务时自动使用它。</p>}
          {profile.skills.map((s) => (
            <div className={`pz-item ${s.enabled ? "" : "off"}`} key={s.id}>
              <label className="pz-toggle"><input type="checkbox" checked={s.enabled} onChange={(e) => setSkills(profile.skills.map((x) => (x.id === s.id ? { ...x, enabled: e.target.checked } : x)))} /></label>
              <div className="pz-skill">
                <b>{s.name}</b>
                {s.description && <span>{s.description}</span>}
              </div>
              <div className="pz-item-actions">
                <button className="pz-mini danger" onClick={() => setSkills(profile.skills.filter((x) => x.id !== s.id))} title="删除">×</button>
              </div>
            </div>
          ))}
        </div>
        <p className="pz-note">Skill 只是用户写的指令/工作流知识，按任务相关度注入；绝不自动获得 MCP / shell 权限，也不会写入全局 ~/.claude。</p>
      </section>
    </div>
  );
}
