"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import TopNav from "../../components/TopNav";
import MessageParts from "../../components/message/MessageParts";
import PersonalizationPanel from "../../components/personalization/Panel";
import { createAccumulator, accumulate, finalizeStatus, streamingStatus, sanitizeForUpstream } from "../../lib/message/lifecycle";
import { transformContent } from "../../lib/artifacts/transform";
import { normalizeMessageStatus } from "../../lib/message/types";
import { buildPersonalizationContext, defaultProfile, loadProfile, saveProfile, selectRelevantSkills, type PersonalizationProfile } from "../../lib/personalization";
import { isFileTaskPrompt, resolveTaskTools } from "../../lib/toolRegistry";
import { classifyTask } from "../../lib/taskRouter";
import { isGeneratorKind } from "../../lib/generators/types";
import { applyJobEvent, INITIAL_JOB } from "../../lib/job/ui";
import type { JobState } from "../../lib/job/ui";
async function copyText(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return; }
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch {}
  document.body.removeChild(ta);
}


type Provider = "opencode-go" | "anthropic";
type Attachment = { id: string; name: string; mime: string; kind: "text" | "image"; text?: string; dataUrl?: string; originalChars?: number; contextChars?: number; compressed?: boolean };
type WebSource = { title: string; url: string; summary?: string; content?: string };
type Message = { id: string; role: "user" | "assistant"; content: string; status?: string; reasoning?: string; model?: string; provider?: Provider; attachments?: Attachment[]; webUsed?: boolean; urlUsed?: boolean; visionUsed?: boolean; webSources?: WebSource[]; urlSources?: WebSource[]; artifacts?: Artifact[]; job?: JobState };
type Artifact = { id: string; name: string; mime: string; size: number; downloadUrl: string; kind?: string; status?: string };
type FileTaskInfo = { id: string; file: File };

function toolLabel(n: string) {
  const m: Record<string, string> = { Read: "读取文件", Write: "写入文件", Edit: "修改文件", Glob: "查找文件", Grep: "搜索内容", Bash: "执行命令" };
  return m[n] || "处理文件";
}
function fmtSize(b: number) { if (b < 1024) return b + " B"; if (b < 1048576) return (b / 1024).toFixed(1) + " KB"; return (b / 1048576).toFixed(1) + " MB"; }
type ModelInfo = { key: string; id: string; displayName: string; provider: Provider; modelToken: string; protocol: "chat" | "messages" | "responses" | "anthropic" | null; supported: boolean; reasoning: true | false | "unknown"; vision: true | false | "unknown"; files: string; web: string; providerMeta?: any; featuredRank?: number | null; useCase?: string | null; temperaturePolicy?: { mode: "fixed" | "range" | "unsupported"; value?: number; min?: number; max?: number }; reasoningPolicy?: "instruct" | "none" };
type Conversation = { id: string; title: string; model: string; provider?: Provider; messages: Message[]; updatedAt: number };
type StreamEvent = { type: "meta" | "text" | "reasoning" | "error" | "done"; value?: string; protocol?: string; provider?: Provider; stopReason?: string };
type SearchMode = "off" | "auto" | "on";
type ContextMode = "compact" | "balanced" | "full";
type ReasoningEffort = "off" | "auto" | "low" | "medium" | "high";
type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "go-ai-conversations-v3";
const SETTINGS_KEY = "go-ai-settings-v3";
const MAX_FILES = 4;
const MAX_IMAGE_FILE_BYTES = 12_000_000;
const MAX_PDF_FILE_BYTES = 15_000_000;
const MAX_TEXT_FILE_BYTES = 5_000_000;
const MAX_CLIENT_REQUEST_BYTES = 3_300_000;
const MAX_TEXT_ATTACHMENT_CHARS = 160_000;
const MAX_IMAGE_ATTACHMENT_BYTES = 1_250_000;
function uid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return h.slice(0,8) + "-" + h.slice(8,12) + "-" + h.slice(12,16) + "-" + h.slice(16,20) + "-" + h.slice(20);
}
function prettyModel(id: string) {
  return id.replace(/^anthropic\//, "").split("-").map((x) => /^v?\d/.test(x) ? x.toUpperCase() : x.charAt(0).toUpperCase() + x.slice(1))
    .join(" ").replace("Gpt", "GPT").replace("Glm", "GLM").replace("Mimo", "MiMo");
}

function safeSourceHref(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch { return undefined; }
}

/** 服务端结构化模型可用性错误 → 友好中文（不把 provider 原始错误直接展示）。 */
function friendlyApiError(j: any): string {
  if (!j || typeof j !== "object") return "";
  const code = j.code;
  if (code === "MODEL_QUOTA_EXCEEDED") {
    const mins = Math.ceil(j.retryAfterSeconds / 60);
    return `${j.model} 的 ${j.window === "5h" ? "5 小时" : "7 天"}额度已用完（${j.used}/${j.limit}），约 ${mins} 分钟后恢复` + (j.window === "5h" ? `，本周 ${j.used7d}/${j.limit7d}` : "");
  }
  if (["MODEL_REGION_UNAVAILABLE", "MODEL_NOT_FOUND", "MODEL_TEMP_UNAVAILABLE", "MODEL_QUOTA_EXCEEDED_UPSTREAM", "MODEL_ERROR"].includes(code)) {
    return typeof j.message === "string" && j.message ? j.message : "模型请求失败，请重试或切换模型。";
  }
  return "";
}

function extractUrls(text: string) {
  return Array.from(new Set(text.match(/https?:\/\/[^\s)\]}>"']+/g) || [])).slice(0, 5);
}

function compactText(text: string, mode: ContextMode) {
  const full = text || "";
  const limit = mode === "full" ? MAX_TEXT_ATTACHMENT_CHARS : mode === "balanced" ? 45_000 : 16_000;
  if (full.length <= limit) return { text: full, compressed: false, contextChars: full.length };
  const omissionMarker = "\n\n[... content omitted by client context compression ...]\n\n";
  const endMarker = "\n\n[... end section ...]\n\n";
  const contentBudget = Math.max(0, limit - omissionMarker.length - endMarker.length);
  const head = Math.floor(contentBudget * 0.48);
  const mid = Math.floor(contentBudget * 0.18);
  const tail = contentBudget - head - mid;
  const middleStart = Math.max(0, Math.floor(full.length / 2 - mid / 2));
  const compacted = `${full.slice(0, head)}${omissionMarker}${full.slice(middleStart, middleStart + mid)}${endMarker}${full.slice(-tail)}`;
  return {
    text: compacted,
    compressed: true,
    contextChars: compacted.length
  };
}

function dataUrlByteLength(dataUrl: string) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return Number.POSITIVE_INFINITY;
  return Math.floor(dataUrl.slice(comma + 1).replace(/=/g, "").length * 3 / 4);
}

async function imageToDataUrl(file: File): Promise<{ dataUrl: string; mime: string }> {
  const allowed = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
  if (!allowed.has(file.type)) throw new Error("仅支持 JPEG、PNG、GIF 或 WebP 图片");
  if (file.size > MAX_IMAGE_FILE_BYTES) throw new Error("单张图片不能超过 12 MB");
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file);
  });
  if (file.size <= 800_000) return { dataUrl: raw, mime: file.type };
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const maxSide = 1280;
      const ratio = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * ratio));
      canvas.height = Math.max(1, Math.round(img.height * ratio));
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("浏览器无法处理这张图片")); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      let dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      if (dataUrlByteLength(dataUrl) > MAX_IMAGE_ATTACHMENT_BYTES) dataUrl = canvas.toDataURL("image/jpeg", 0.68);
      if (dataUrlByteLength(dataUrl) > MAX_IMAGE_ATTACHMENT_BYTES) { reject(new Error("图片压缩后仍然超过 1.25 MB 上下文限制")); return; }
      resolve({ dataUrl, mime: "image/jpeg" });
    };
    img.onerror = () => reject(new Error("图片格式无法读取"));
    img.src = raw;
  });
}

async function fileToAttachment(file: File): Promise<Attachment> {
  const id = uid();
  if (file.type.startsWith("image/")) {
    const image = await imageToDataUrl(file);
    return { id, name: file.name, mime: image.mime, kind: "image", dataUrl: image.dataUrl };
  }
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    if (file.size > MAX_PDF_FILE_BYTES) throw new Error("单个 PDF 不能超过 15 MB");
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    if (pdf.numPages > 120) throw new Error("PDF 不能超过 120 页");
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i); const text = await page.getTextContent();
      pages.push(`[Page ${i}]\n${text.items.map((x: any) => x.str || "").join(" ")}`);
    }
    const text = pages.join("\n\n");
    if (!text.replace(/\[Page \d+\]/g, "").trim()) throw new Error("这个 PDF 没有可提取文字，扫描版需要先做 OCR");
    return { id, name: file.name, mime: file.type || "application/pdf", kind: "text", text, originalChars: text.length };
  }
  if (file.size > MAX_TEXT_FILE_BYTES) throw new Error("单个文本或代码文件不能超过 5 MB");
  const text = await file.text();
  return { id, name: file.name, mime: file.type || "text/plain", kind: "text", text, originalChars: text.length };
}

function contextAttachment(a: Attachment, mode: ContextMode): Attachment {
  if (a.kind !== "text" || !a.text) return a;
  const c = compactText(a.text, mode);
  return { ...a, text: c.text, compressed: c.compressed, contextChars: c.contextChars, originalChars: a.originalChars || a.text.length };
}

function sourceLabel(s: WebSource, i: number) {
  try { return `${i + 1}. ${new URL(s.url).hostname}`; } catch { return `${i + 1}. source`; }
}

export default function Home() {
  const [password, setPassword] = useState("");
  const E2E = process.env.NEXT_PUBLIC_E2E_MODE === "1" && process.env.NODE_ENV !== "production";
  const [authed, setAuthed] = useState(E2E);
  const [loginError, setLoginError] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providerWarnings, setProviderWarnings] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState("");
  const [showOtherModels, setShowOtherModels] = useState(false);
  const [allowOtherModels, setAllowOtherModels] = useState(false);
  const [model, setModel] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [visionBusy, setVisionBusy] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>("auto");
  const [contextMode, setContextMode] = useState<ContextMode>("balanced");
  const [temperature, setTemperature] = useState(0.7);
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("auto");
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [profile, setProfile] = useState<PersonalizationProfile>(defaultProfile);
  const [view, setView] = useState<"chat" | "settings" | "personalization">("chat");
  const [error, setError] = useState("");
  const [sidebar, setSidebar] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [currentId, setCurrentId] = useState<string>(uid());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  async function copyMessage(m: Message) { await copyText(m.content || ""); setCopiedId(m.id); setTimeout(() => setCopiedId(null), 1500); }
  const abortRef = useRef<AbortController | null>(null);
  const authRunRef = useRef(0);
  const runRef = useRef(0);
  const fileRunRef = useRef(0);
  const fileBusyRef = useRef(false);
  const filesRef = useRef<FileTaskInfo[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    const setRaw = localStorage.getItem(SETTINGS_KEY);
    let restoredConversations: Conversation[] = [];
    if (raw) try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) restoredConversations = parsed.slice(0, 80)
        .filter((conversation: any) => conversation && typeof conversation === "object")
        .map((conversation: any) => ({
          id: typeof conversation.id === "string" ? conversation.id : uid(),
          title: typeof conversation.title === "string" ? conversation.title : "旧对话",
          model: typeof conversation.model === "string" ? conversation.model : "",
          ...(conversation.provider === "opencode-go" || conversation.provider === "anthropic" ? { provider: conversation.provider } : {}),
          messages: storageSafeMessages(Array.isArray(conversation.messages)
            ? conversation.messages.filter((message: any) => message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string" && (message.role !== "assistant" || message.content.trim() || (Array.isArray(message.artifacts) && message.artifacts.length)))
            : []),
          updatedAt: typeof conversation.updatedAt === "number" ? conversation.updatedAt : Date.now()
        }));
    } catch {}
    setConversations(restoredConversations);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(restoredConversations)); } catch {}
    // 刷新后恢复最近对话为当前会话（历史/Artifact 刷新仍可见）
    const recent = restoredConversations[0];
    if (recent) {
      setCurrentId(recent.id);
      setMessages(Array.isArray(recent.messages) ? recent.messages : []);
      setModel(typeof recent.model === "string" ? recent.model : "");
    }
    if (setRaw) try {
      const s = JSON.parse(setRaw);
      if (["off", "auto", "on"].includes(s.searchMode)) setSearchMode(s.searchMode);
      if (["compact", "balanced", "full"].includes(s.contextMode)) setContextMode(s.contextMode);
      if (typeof s.temperature === "number") setTemperature(s.temperature);
      if (s.maxOutputTokens != null) setMaxOutputTokens(String(s.maxOutputTokens || ""));
      if (["off", "auto", "low", "medium", "high"].includes(s.reasoningEffort)) setReasoningEffort(s.reasoningEffort);
      if (["system", "light", "dark"].includes(s.theme)) setTheme(s.theme);
    } catch {}
    setProfile(loadProfile());
    setStorageReady(true);
    void authenticate(true);
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy, searchBusy]);
  useEffect(() => { if (!storageReady) return; try { localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations)); } catch {} }, [conversations, storageReady]);
  useEffect(() => { if (!storageReady) return; try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ searchMode, contextMode, temperature, maxOutputTokens, reasoningEffort, theme })); } catch {} }, [searchMode, contextMode, temperature, maxOutputTokens, reasoningEffort, theme, storageReady]);
  useEffect(() => { if (!storageReady) return; saveProfile(profile); }, [profile, storageReady]);

  // 自动主题：system 跟随系统；light/dark 手动覆盖。无硬编码时间点。
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

  const router = useRouter();
  async function authenticate(silent = true) {
    const authRunId = authRunRef.current + 1;
    authRunRef.current = authRunId;
    try {
      const meRes = await fetch("/api/auth/me", { cache: "no-store" });
      if (authRunRef.current !== authRunId) return;
      if (meRes.status === 401) { router.replace("/login"); return; }
      const modelResponse = await fetch("/api/models", { cache: "no-store" });
      const data = await modelResponse.json().catch(() => ({}));
      if (authRunRef.current !== authRunId) return;
      if (!modelResponse.ok) { setAuthed(false); return; }
      setModels(Array.isArray(data.models) ? data.models : []);
      setAllowOtherModels(data.allowOtherModels === true);
      setProviderWarnings(Array.isArray(data.warnings) ? data.warnings.filter((value: unknown) => typeof value === "string") : []);
      setAuthed(true);
    } catch {
      if (authRunRef.current !== authRunId) return;
      setAuthed(false);
    }
  }

  const featuredModels = useMemo(() => models
    .filter((m) => typeof m.featuredRank === "number")
    .sort((a, b) => (a.featuredRank ?? 999) - (b.featuredRank ?? 999)), [models]);
  const otherModels = useMemo(() => models
    .filter((m) => typeof m.featuredRank !== "number")
    .filter((m) => `${m.id} ${m.displayName} ${m.provider}`.toLowerCase().includes(modelSearch.toLowerCase())), [models, modelSearch]);
  const selectedModel = useMemo(() => models.find((m) => m.key === model), [models, model]);

  function storageSafeMessages(nextMessages: Message[]) {
    return nextMessages.map((message) => {
      // 旧消息可能缺 id → 补一个，避免 React key 警告与列表错乱
      const safeId = typeof message.id === "string" && message.id ? message.id : uid();
      const attachments = (Array.isArray(message.attachments) ? message.attachments : [])
        .filter((attachment: any) => attachment && typeof attachment === "object" && (attachment.kind === "text" || attachment.kind === "image"))
        .map((attachment: any) => ({
          id: typeof attachment.id === "string" ? attachment.id : uid(),
          name: typeof attachment.name === "string" ? attachment.name : "未命名附件",
          mime: typeof attachment.mime === "string" ? attachment.mime : "application/octet-stream",
          kind: attachment.kind as Attachment["kind"],
          ...(typeof attachment.originalChars === "number" ? { originalChars: attachment.originalChars } : {}),
          ...(typeof attachment.contextChars === "number" ? { contextChars: attachment.contextChars } : {}),
          ...(typeof attachment.compressed === "boolean" ? { compressed: attachment.compressed } : {})
        }));
      const attachmentNote = attachments?.length
        ? `[附件内容未保存在浏览器；如需继续引用，请重新添加：${attachments.map((attachment) => attachment.name).join("、")}]`
        : "";
      const content = attachmentNote && !message.content.includes("[附件内容未保存在浏览器")
        ? [message.content, attachmentNote].filter(Boolean).join("\n\n")
        : message.content;
      return {
        ...message,
        id: safeId,
        content,
        status: normalizeMessageStatus(message.status),
        attachments: attachments.length ? attachments : undefined,
        webSources: Array.isArray(message.webSources) ? message.webSources.map(({ title, url, summary }) => ({ title, url, summary })) : undefined,
        urlSources: Array.isArray(message.urlSources) ? message.urlSources.map(({ title, url, summary }) => ({ title, url, summary })) : undefined
      };
    });
  }

  function persist(nextMessages: Message[], activeModel = model, activeProvider = selectedModel?.provider) {
    const title = nextMessages.find((m) => m.role === "user")?.content.trim().slice(0, 28) || "新对话";
    const item = { id: currentId, title, model: activeModel, provider: activeProvider, messages: storageSafeMessages(nextMessages), updatedAt: Date.now() };
    setConversations((old) => [item, ...old.filter((x) => x.id !== currentId)].slice(0, 80));
  }

  function stopActiveRun() {
    runRef.current += 1;
    fileRunRef.current += 1;
    fileBusyRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setFileBusy(false);
    setSearchBusy(false);
    setVisionBusy(false);
  }

  async function processAutoArtifact(messages: Message[], prompt: string): Promise<Message[]> {
    const explicit = /(给我.*文件|发.*文件|生成.*(html|index)|html 文件|文件给我|给我下载)/i.test(prompt);
    const out = messages.slice();
    const last = out[out.length - 1];
    if (!last || last.role !== "assistant") return out;
    const res = transformContent(last.content, explicit);
    if (!res.requests.length) return out;
    const created: Artifact[] = [];
    for (const r of res.requests) {
      try {
        const resp = await fetch("/api/artifacts/create", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ filename: r.filename, mime: r.mime, kind: r.kind, content: r.content, messageId: last.id, source: "chat" }),
        });
        if (resp.ok) created.push(await resp.json());
      } catch {}
    }
    const artifacts = [...created, ...(last.artifacts || [])];
    return [...out.slice(0, -1), { ...last, content: res.content, artifacts }];
  }

  async function runFileTask(prompt: string, convId: string, jobId: string) {
    const retained = filesRef.current;
    const fd = new FormData();
    for (const r of retained) fd.append("files", r.file, r.file.name);
    const up = await fetch(`/api/files/upload?conversationId=${convId}&jobId=${jobId}`, { method: "POST", body: fd });
    if (!up.ok) throw new Error((await up.text()).slice(0, 200) || "上传失败");

    const pz = buildPersonalizationContext(profile);
    const res = await fetch("/api/agent/task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convId, jobId, prompt, memory: pz.memory ? pz.memory.split("\n").map((s) => s.replace(/^- /, "").trim()).filter(Boolean) : [], style: pz.style, skills: selectRelevantSkills(profile.skills, prompt).map((s) => s.content) }),
    });
    if (!res.ok || !res.body) throw new Error((await res.text()).slice(0, 200) || "文件处理失败");

    let job: JobState = INITIAL_JOB;
    let artifacts: Artifact[] = [];
    const paint = () => {
      setMessages((prev) => {
        const out = prev.slice();
        const last = out[out.length - 1];
        if (last && last.role === "assistant") {
          out[out.length - 1] = { ...last, job, artifacts: artifacts.length ? artifacts : last.artifacts };
        }
        return out;
      });
    };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          let ev: any;
          try { ev = JSON.parse(t); } catch { continue; }
          job = applyJobEvent(job, ev);
          if (ev.type === "artifact" && ev.artifact) {
            artifacts = [...artifacts, { id: ev.artifact.id, name: ev.artifact.name, mime: ev.artifact.mime, size: ev.artifact.size, downloadUrl: `/api/artifacts/${ev.artifact.id}`, kind: ev.artifact.kind, status: ev.artifact.status }];
          }
          paint();
        }
      }
    } catch (e) { throw new Error("文件处理中断"); }
    paint();
  }

  function newChat() { stopActiveRun(); setCurrentId(uid()); setMessages([]); setInput(""); setAttachments([]); setModel(""); setError(""); setShowOtherModels(false); setSidebar(false); setView("chat"); }
  function openChat(c: Conversation) { stopActiveRun(); setCurrentId(c.id); setMessages(c.messages); setModel(c.model || ""); if (c.model && !models.find((m) => m.key === c.model && typeof m.featuredRank === "number")) setShowOtherModels(true); setAttachments([]); setError(""); setSidebar(false); setView("chat"); }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    if (fileBusyRef.current) { setError("已有文件正在读取，请等待完成后再添加。"); return; }
    if (attachments.length + files.length > MAX_FILES) { setError(`一次最多添加 ${MAX_FILES} 个文件。`); return; }
    const fileRunId = fileRunRef.current + 1;
    fileRunRef.current = fileRunId;
    fileBusyRef.current = true;
    setFileBusy(true); setError("");
    try {
      const parsed: Attachment[] = [];
      const retained: FileTaskInfo[] = [];
      for (const file of Array.from(files)) { const a = await fileToAttachment(file); parsed.push(a); retained.push({ id: a.id, file }); }
      filesRef.current = [...filesRef.current, ...retained];
      if (fileRunRef.current === fileRunId) setAttachments((old) => [...old, ...parsed].slice(0, MAX_FILES));
    } catch (e: any) {
      if (fileRunRef.current === fileRunId) setError(`文件读取失败：${e?.message || e}`);
    } finally {
      if (fileRunRef.current === fileRunId) { fileBusyRef.current = false; setFileBusy(false); }
    }
  }

  async function getExternalContext(query: string, signal: AbortSignal, runId: number, tools: string[]) {
    const urls = extractUrls(query);
    const result = { webContext: "", urlContext: "", webSources: [] as WebSource[], urlSources: [] as WebSource[], webUsed: false, urlUsed: false };
    const shouldFetch = tools.includes("url_fetch") && urls.length > 0;
    const shouldSearch = tools.includes("web_search") && query.trim().length > 0;
    if (runRef.current === runId) setSearchBusy(shouldFetch || shouldSearch);
    try {
      if (shouldFetch) {
        const r = await fetch("/api/fetch-url", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ urls }), signal });
        const data = await r.json(); if (!r.ok) throw new Error(data.detail || data.error || "URL 读取失败");
        result.urlContext = data.content || ""; result.urlSources = data.sources || []; result.urlUsed = true;
      }
      if (shouldSearch) {
        const r = await fetch("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, numResults: 6 }), signal });
        const data = await r.json(); if (!r.ok) throw new Error(data.detail || data.error || "搜索失败");
        result.webContext = data.content || ""; result.webSources = data.sources || []; result.webUsed = true;
      }
      return result;
    } finally { if (runRef.current === runId) setSearchBusy(false); }
  }

  function cycleSearchMode() {
    setSearchMode((m) => m === "auto" ? "on" : m === "on" ? "off" : "auto");
  }

  async function send() {
    if (busy) return;
    if (fileBusyRef.current) { setError("文件仍在读取，请稍等完成后再发送。"); return; }
    if (!input.trim() && attachments.length === 0) return;

    const intent = classifyTask({ message: input.trim(), attachments });
    const isTaskRoute = Boolean(intent && (intent.type === "artifact" || intent.type === "agent_workspace"));
    // 任务型请求走任务系统（DeepSeek/确定性生成器/Agent Workspace），不依赖聊天模型选择
    if (!isTaskRoute) {
      if (!model) { setError("先选择一个模型。这里没有默认模型。"); return; }
      if (!selectedModel) { setError("模型列表已经变化，请刷新页面后重选。"); return; }
      if (!selectedModel.supported) { setError("这个模型已出现，但当前协议路由尚未识别。"); return; }
    }

    if (intent && intent.type === "artifact" && isGeneratorKind(intent.artifactKind)) {
      setBusy(true); setError("");
      const assistant: Message = { id: uid(), role: "assistant", content: "任务已创建，正在生成文件…" };
      setMessages((prev) => [...prev, assistant]);
      try {
        // M1：multipart 直传任务系统（原始文件 + goal），任务页展示执行与产物
        const form = new FormData();
        form.append("goal", input.trim());
        filesRef.current.forEach((r) => form.append("files", r.file, r.file.name));
        const r = await fetch("/api/tasks", { method: "POST", body: form });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) throw new Error(data.error || "文件生成失败");
        setInput(""); setAttachments([]); filesRef.current = [];
        router.push(`/tasks/${data.task.id}`);
      } catch (e: any) {
        setMessages((prev) => prev.slice(0, -1));
        setError("文件生成失败：" + (e?.message || e));
      }
      setBusy(false);
      return;
    }

    const useLegacy = !intent || intent.type !== "artifact" || !isGeneratorKind(intent.artifactKind);
    if (intent?.type === "agent_workspace" || (useLegacy && isFileTaskPrompt(input.trim(), attachments.length > 0))) {
      setBusy(true); setError("");
      const assistant: Message = { id: uid(), role: "assistant", content: "任务已创建，进入工作区处理…" };
      setMessages((prev) => [...prev, assistant]);
      try {
        // M2：图片+文件修改类请求统一进任务系统（type=agent_workspace，dev 步骤执行）
        const form = new FormData();
        form.append("goal", input.trim());
        form.append("type", "agent_workspace");
        filesRef.current.forEach((r) => form.append("files", r.file, r.file.name));
        const r = await fetch("/api/tasks", { method: "POST", body: form });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) throw new Error(data.error || "任务创建失败");
        setInput(""); setAttachments([]); filesRef.current = [];
        router.push(`/tasks/${data.task.id}`);
      } catch (e: any) {
        setMessages((prev) => prev.slice(0, -1));
        setError("任务创建失败：" + (e?.message || e));
      }
      setBusy(false);
      return;
    }

    setError(""); setBusy(true);
    const runId = runRef.current + 1;
    runRef.current = runId;
    const activeModel = selectedModel!; // 任务分支已提前 return，此处必有模型
    const prompt = input.trim();
    const preparedAttachments = attachments.map((a) => contextAttachment(a, contextMode));
    const hasImages = preparedAttachments.some((a) => a.kind === "image");
    const visionUsed = hasImages && selectedModel!.vision !== true;
    if (visionUsed) setVisionBusy(true);
    const taskTools = resolveTaskTools(prompt, { searchMode, hasUrls: extractUrls(prompt).length > 0, hasImages, hasFiles: preparedAttachments.length > 0 });
    const userBase: Message = { id: uid(), role: "user", content: prompt, attachments: preparedAttachments, webUsed: false, urlUsed: extractUrls(prompt).length > 0, visionUsed };
    const assistant: Message = { id: uid(), role: "assistant", content: "", reasoning: "", model: activeModel.key, provider: activeModel.provider };
    let outgoing: Message[] = [...messages, userBase];
    setMessages([...outgoing, assistant]); setInput(""); setAttachments([]); persist(outgoing, activeModel.key, activeModel.provider);
    const controller = new AbortController(); abortRef.current = controller;
    let streamedText = "";
    let streamedReasoning = "";
    const _acc = createAccumulator();

    try {
      const external = prompt ? await getExternalContext(prompt, controller.signal, runId, taskTools) : { webContext: "", urlContext: "", webSources: [], urlSources: [], webUsed: false, urlUsed: false };
      if (runRef.current !== runId) return;
      const user = { ...userBase, webUsed: external.webUsed, urlUsed: external.urlUsed, webSources: external.webSources, urlSources: external.urlSources };
      outgoing = [...messages, user];
      setMessages([...outgoing, assistant]); persist(outgoing, activeModel.key, activeModel.provider);

      const options = {
        temperature,
        maxOutputTokens: maxOutputTokens.trim() ? Number(maxOutputTokens) : null,
        reasoningEffort
      };
      const requestMessages = sanitizeForUpstream(outgoing.slice(-40));
      if (requestMessages[0]?.role === "assistant") requestMessages.shift();
      const apiMessages = requestMessages.map(({ role, content, attachments: messageAttachments }) => ({
        role,
        content,
        attachments: messageAttachments?.filter((attachment) =>
          (attachment.kind === "text" && typeof attachment.text === "string") ||
          (attachment.kind === "image" && typeof attachment.dataUrl === "string")
        ).map(({ name, mime, kind, text, dataUrl }) => ({ name, mime, kind, text, dataUrl }))
      }));
      const pz = buildPersonalizationContext(profile);
      const relevantSkills = selectRelevantSkills(profile.skills, prompt);
      const requestBody = JSON.stringify({
        provider: activeModel.provider,
        model: activeModel.id,
        modelToken: activeModel.modelToken,
        messages: apiMessages,
        webContext: external.webContext,
        urlContext: external.urlContext,
        options,
        visionCapability: activeModel.vision,
        personalization: pz,
        skills: relevantSkills.map((s) => ({ name: s.name, content: s.content }))
      });
      if (new Blob([requestBody]).size > MAX_CLIENT_REQUEST_BYTES) throw new Error("当前对话和附件超过 3.3 MB，请新建对话或减少文件/图片");
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
        signal: controller.signal
      });
      setVisionBusy(false);
      if (!res.ok || !res.body) {
        const errText = (await res.text()) || `HTTP ${res.status}`;
        let friendly = "";
        try { friendly = friendlyApiError(JSON.parse(errText)); } catch {}
        throw new Error(friendly || errText);
      }
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = "", streamError = "", stopReason = "", sawDone = false, lastPaint = 0;
      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        let ev: StreamEvent; try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === "text") streamedText += ev.value || "";
        if (ev.type === "reasoning") streamedReasoning += ev.value || "";
        accumulate(_acc, ev as any);
        if (ev.type === "error") streamError = ev.value || "上游流式响应失败";
        if (ev.type === "done") { sawDone = true; if (ev.stopReason) stopReason = ev.stopReason; }
        const now = performance.now();
        if ((ev.type === "text" || ev.type === "reasoning") && now - lastPaint >= 40 && runRef.current === runId) {
          lastPaint = now;
          // WP8：流式状态区分思考/回答阶段（reasoning → streaming_reasoning，text → streaming_final）
          setMessages([...outgoing, { ...assistant, content: streamedText, reasoning: streamedReasoning, status: streamingStatus({ text: streamedText, reasoning: streamedReasoning, parts: [] }) }]);
        }
      };
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const line of lines) consumeLine(line);
      }
      buf += decoder.decode();
      if (buf.trim()) consumeLine(buf);
      if (streamError) throw new Error(streamError);
      if (!sawDone) {
        if (controller.signal.aborted) throw new DOMException("Request aborted", "AbortError");
        throw new Error("流式响应提前结束：未收到服务端完成标记");
      }
      if (runRef.current !== runId) return;
      const _finalText = String(streamedText || "").trim();
      const _finalReason = String(streamedReasoning || "").trim();
      const _hasArtifact = !!(assistant.artifacts && assistant.artifacts.length);
      const _status = finalizeStatus({ text: streamedText, reasoning: streamedReasoning, parts: [] }, _hasArtifact);
      const _content = !_finalText ? (_finalReason ? "（模型完成了推理，但没有返回最终回答，可以重试。）" : "") : streamedText;
      const completed = [...outgoing, { ...assistant, content: _content, reasoning: streamedReasoning, status: _status }];
      setMessages(completed);
      persist(completed, activeModel.key, activeModel.provider);
      if (_status === "incomplete" || _status === "failed") {
        // WP8：异常完成不得作为正常 assistant 消息进入下一轮（sanitizeForUpstream 已过滤），UI 明确提示
        setError(_status === "incomplete"
          ? "模型返回了推理过程，但没有返回最终答案。请重试。"
          : "模型未返回任何有效回答，请重试。");
      }
      if (_status === "completed") {
        processAutoArtifact(completed, prompt).then((updated) => { if (runRef.current === runId) { setMessages(updated); persist(updated, activeModel.key, activeModel.provider); } });
      }
      if (/max_tokens|incomplete|model_context_window_exceeded/i.test(stopReason)) setError("回答因输出或上下文上限提前结束。");
    } catch (e: any) {
      if (runRef.current === runId) {
        const partial = streamedText || streamedReasoning ? [...outgoing, { ...assistant, content: streamedText, reasoning: streamedReasoning }] : outgoing;
        setMessages(partial);
        persist(partial, activeModel.key, activeModel.provider);
        if (e?.name !== "AbortError") setError(`请求失败：${e?.message || e}`);
      }
    } finally {
      if (runRef.current === runId) { setBusy(false); setSearchBusy(false); setVisionBusy(false); abortRef.current = null; }
    }
  }

  const searchLabel = searchMode === "auto" ? "自动联网" : searchMode === "on" ? "强制联网" : "关闭联网";

  if (!authed) return <main className="login-shell"><section className="login-card"><p className="auth-hint">正在验证登录状态…</p></section></main>;

  return <main className="app-shell">
      <TopNav />
    <aside className={`sidebar ${sidebar ? "open" : ""}`}><div className="side-head"><strong>Go AI</strong><button onClick={() => setSidebar(false)}>×</button></div><button className="new-chat" onClick={newChat}>＋ 新对话</button><div className="history">{conversations.map((c) => <button key={c.id} className={c.id === currentId ? "active" : ""} onClick={() => openChat(c)}><span>{c.title}</span><small>{c.model ? prettyModel(c.model) : "未选模型"}</small></button>)}</div><div className="side-foot"><button className={`side-nav ${view === "personalization" ? "active" : ""}`} onClick={() => { setSidebar(false); setView("personalization"); }}><span>🧭</span>个性化</button><button className={`side-nav ${view === "settings" ? "active" : ""}`} onClick={() => { setSidebar(false); setView("settings"); }}><span>⚙</span>设置</button></div></aside>
    {sidebar && <div className="scrim" onClick={() => setSidebar(false)} />}

    <section className="chat-panel">
      <header><button className="icon-btn" onClick={() => setSidebar(true)}>☰</button><div className="model-wrap"><span className="eyebrow">MODEL</span><select value={model} onChange={(e) => setModel(e.target.value)}><option value="">选择最强模型…</option>{featuredModels.length ? <optgroup label="最佳模型">{featuredModels.map((m) => <option key={m.key} value={m.key} disabled={!m.supported}>{m.displayName || prettyModel(m.id)} · {m.provider === "anthropic" ? "Claude" : "Go"}{m.useCase ? ` · ${m.useCase}` : ""}{!m.supported ? " · route?" : ""}</option>)}</optgroup> : null}{showOtherModels && otherModels.length ? <optgroup label="其他模型 · 高级选项">{otherModels.map((m) => <option key={m.key} value={m.key} disabled={!m.supported}>{m.displayName || prettyModel(m.id)} · {m.provider === "anthropic" ? "Claude" : "Go"}{!m.supported ? " · route?" : ""}</option>)}</optgroup> : null}</select></div>{view === "chat" ? <button className="icon-btn" onClick={newChat}>＋</button> : <button className="icon-btn" title="返回聊天" onClick={() => setView("chat")}>✕</button>}</header>

      {view === "chat" ? <>
        <div className="model-controls">
          <div className="model-search">{allowOtherModels && <button className={showOtherModels ? "other-toggle active" : "other-toggle"} onClick={() => setShowOtherModels((x) => !x)}>{showOtherModels ? "收起其他模型" : "显示其他模型"}</button>}{allowOtherModels && showOtherModels && <input value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} placeholder="搜索其他模型" />}</div>
          {providerWarnings.length > 0 && <div className="provider-warning">{providerWarnings.join(" ")}</div>}
        </div>

        <div className="messages">
          {messages.length === 0 && <div className="empty-state"><div className="hero-orb">AI</div><h2>只把最强模型放在入口。</h2><p>OpenCode Go 始终可独立使用；配置 Anthropic Key 后会自动加入 Claude。联网、URL 和文件内容都只经服务端授权接口处理。</p></div>}
          {messages.map((m) => <article key={m.id} className={`message ${m.role}`}><div className="role">{m.role === "user" ? "YOU" : prettyModel(m.model || model || "AI")}</div>
            {(m.attachments?.length || m.webUsed || m.urlUsed || m.visionUsed) ? <div className="chips">{m.webUsed && <span>◎ 搜索</span>}{m.urlUsed && <span>↗ URL</span>}{m.visionUsed && !busy && <span>▧ 视觉分析</span>}{m.attachments?.map((a) => <span key={a.id}>{a.kind === "image" ? "▧" : "▤"} {a.name}{a.compressed ? " · 已压缩" : ""}</span>)}</div> : null}
            {m.urlSources?.length ? <div className="source-grid">{m.urlSources.map((s, i) => <a key={`${s.url}-${i}`} href={safeSourceHref(s.url)} target="_blank" rel="noreferrer"><b>{sourceLabel(s, i)}</b><span>{s.summary || s.title}</span></a>)}</div> : null}
            {m.webSources?.length ? <div className="source-grid">{m.webSources.map((s, i) => <a key={`${s.url}-${i}`} href={safeSourceHref(s.url)} target="_blank" rel="noreferrer"><b>{sourceLabel(s, i)}</b><span>{s.summary || s.title}</span></a>)}</div> : null}
            <MessageParts message={m} busy={busy} />
            {m.role === "assistant" && <button className="msg-copy" onClick={() => copyMessage(m)}>{copiedId === m.id ? "已复制 ✓" : "复制"}</button>}
          </article>)}
          <div ref={bottomRef} />
        </div>

        {E2E && <div data-testid="mock-mode-indicator" style={{position:"fixed",top:4,right:8,fontSize:10,color:"#7c8495",zIndex:50}}>E2E-MOCK</div>}
        <footer>{attachments.length > 0 && <div className="attachment-tray">{attachments.map((a) => <button key={a.id} onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))}>{a.kind === "image" ? "▧" : "▤"} {a.name}{a.originalChars ? ` · ${Math.round(a.originalChars / 1000)}k` : ""} <b>×</b></button>)}</div>}{error && <div className="error inline">{error}</div>}
          <div className="tool-row"><button className={searchMode !== "off" ? "tool active" : "tool"} onClick={cycleSearchMode}>◎ {searchBusy ? "检索中" : searchLabel}</button><button className="tool" onClick={() => setView("settings")}>⚙ 设置</button>{visionBusy && <span className="tool status">▧ 视觉分析中…</span>}<span>{selectedModel ? `${prettyModel(selectedModel.id)} · ${selectedModel.protocol}` : "未选择模型"}</span></div>
          <div className="composer"><label className="attach" title="最多 4 个 JPEG/PNG/GIF/WebP、PDF、文本或代码文件">＋<input type="file" multiple disabled={fileBusy} accept="image/jpeg,image/png,image/gif,image/webp,.pdf,.txt,.md,.csv,.json,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.c,.h,.cpp,.html,.css,.xml,.yaml,.yml" onChange={(e) => { handleFiles(e.target.files); e.currentTarget.value = ""; }} /></label><textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} onPaste={(e) => { const items = e.clipboardData?.items; if (!items) return; const files = []; for (let i = 0; i < items.length; i++) { const it = items[i]; if (it.kind === "file" && it.type.startsWith("image/")) { const f = it.getAsFile(); if (f) files.push(f); } } if (!files.length) return; e.preventDefault(); const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f)); handleFiles(dt.files); }} placeholder={fileBusy ? "正在读取文件…" : searchBusy ? "正在检索外部资料…" : "描述任务，或上传文件/图片让 Agent 处理…"} rows={1} data-testid="chat-input" />{busy ? <button className="send stop" data-testid="send-button" onClick={() => abortRef.current?.abort()}>■</button> : <button className="send" data-testid="send-button" onClick={send}>↑</button>}</div>
          <div className="footnote">历史正文保存在本机 · 附件内容不落盘，刷新后需重新添加 · API Key 只在服务端 · URL/联网使用 Exa MCP</div>
        </footer>
      </> : view === "settings" ? (
        <div className="settings-view">
          <div className="view-head"><h2>设置</h2><p>高级选项会立即生效，已按当前模型能力自动禁用不支持的参数。</p></div>
          <div className="settings-grid">
            <label>主题<select value={theme} onChange={(e) => setTheme(e.target.value as ThemeMode)}><option value="system">自动</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
            <label>联网<select value={searchMode} onChange={(e) => setSearchMode(e.target.value as SearchMode)}><option value="auto">自动</option><option value="on">开启</option><option value="off">关闭</option></select></label>
            <label>上下文<select value={contextMode} onChange={(e) => setContextMode(e.target.value as ContextMode)}><option value="compact">压缩</option><option value="balanced">平衡</option><option value="full">尽量完整</option></select></label>
            <label>Reasoning<select value={reasoningEffort} disabled={selectedModel?.reasoningPolicy === "none"} onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffort)}><option value="auto">自动</option><option value="off">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select>{selectedModel?.reasoningPolicy === "none" && <small>当前模型不支持</small>}</label>
            <label>温度{selectedModel?.temperaturePolicy?.mode === "fixed" ? <small>固定 {selectedModel.temperaturePolicy.value}</small> : selectedModel?.provider === "anthropic" ? <small>由 Claude 自动管理</small> : null}{selectedModel?.temperaturePolicy?.mode !== "fixed" && <input type="number" min="0" max="2" step="0.1" value={temperature} disabled={selectedModel?.provider === "anthropic"} onChange={(e) => setTemperature(Number(e.target.value))} />}</label>
            <label>最大输出<input inputMode="numeric" value={maxOutputTokens} onChange={(e) => setMaxOutputTokens(e.target.value.replace(/\D/g, ""))} placeholder="默认" /></label>
          </div>
        </div>
      ) : (
        <div className="settings-view">
          <div className="view-head"><h2>个性化</h2><p>记忆 · 回复风格 · 我的 Skills。按浏览器本地保存，不共享服务器 Profile。</p></div>
          <PersonalizationPanel profile={profile} onChange={setProfile} />
        </div>
      )}
    </section>
  </main>;
}
