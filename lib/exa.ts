import { timeoutSignal } from "./http";
import { safePublicHttpUrl } from "./urls";

export type WebSource = {
  title: string;
  url: string;
  summary?: string;
  content?: string;
};

const DEFAULT_MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa";
const MCP_URL = process.env.EXA_MCP_URL || DEFAULT_MCP_URL;

function parseMcpResponse(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}
  const events = trimmed.split(/\r?\n\r?\n+/);
  for (const event of events.reverse()) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    try { return JSON.parse(data); } catch {}
  }
  return null;
}

async function postMcp(payload: unknown, sessionId?: string, parentSignal?: AbortSignal) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (process.env.EXA_API_KEY) headers["x-api-key"] = process.env.EXA_API_KEY;
  const timeout = timeoutSignal(parentSignal, 20_000);
  try {
    const response = await fetch(MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: timeout.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Exa MCP request failed (${response.status})`);
    return { data: parseMcpResponse(text), sessionId: response.headers.get("mcp-session-id") || sessionId };
  } catch (error) {
    if (timeout.didTimeout()) throw new Error("Exa MCP request timed out");
    throw error;
  } finally {
    timeout.dispose();
  }
}

async function openMcpSession(signal?: AbortSignal) {
  const init = await postMcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "opencode-go-light-client", version: "7.0.0" } }
  }, undefined, signal);
  await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId, signal);
  return init.sessionId;
}

async function callTool(sessionId: string | undefined, name: string, args: unknown, signal?: AbortSignal, id = 2) {
  const call = await postMcp({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, sessionId, signal);
  const error = call.data?.error;
  if (error) throw new Error(typeof error.message === "string" ? error.message.slice(0, 300) : "Exa tool call failed");
  return call.data;
}

function partsToText(result: any) {
  const content = result?.result?.content || result?.content || [];
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content);
  return content.map((part: any) => {
    if (typeof part?.text === "string") return part.text;
    if (part?.type === "resource" && typeof part?.resource?.text === "string") return part.resource.text;
    return "";
  }).filter(Boolean).join("\n\n");
}

function sourceFromRaw(raw: any): WebSource {
  const candidateUrl = String(raw?.url || raw?.link || "");
  const url = safePublicHttpUrl(candidateUrl) || "";
  return {
    title: String(raw?.title || raw?.name || url || "Web source").slice(0, 180),
    url,
    summary: String(raw?.summary || raw?.text || raw?.snippet || raw?.description || "").slice(0, 900),
    content: String(raw?.content || raw?.text || "").slice(0, 8_000)
  };
}

function tryJsonSources(text: string): WebSource[] {
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const rows = Array.isArray(parsed) ? parsed : parsed.results || parsed.data || parsed.sources || [];
      if (Array.isArray(rows) && rows.length) {
        return rows.map(sourceFromRaw).filter((source: WebSource) => source.url || source.summary || source.content);
      }
    } catch {}
  }
  return [];
}

function regexSources(text: string): WebSource[] {
  const urls = Array.from(new Set(text.match(/https?:\/\/[^\s)\]}>"']+/g) || []))
    .map((url) => safePublicHttpUrl(url))
    .filter((url): url is string => Boolean(url));
  return urls.slice(0, 10).map((url) => {
    const index = text.indexOf(url);
    const before = text.slice(Math.max(0, index - 160), index).split("\n").map((line) => line.trim()).filter(Boolean).pop() || "Web source";
    const after = text.slice(index + url.length, index + url.length + 500).replace(/\s+/g, " ").trim();
    return { title: before.replace(/^[-*#\d.\s]+/, "").slice(0, 110) || url, url, summary: after.slice(0, 350) };
  });
}

export function normalizeSources(rawText: string): WebSource[] {
  const json = tryJsonSources(rawText);
  const sources = json.length ? json : regexSources(rawText);
  if (sources.length) return sources;
  return [{ title: "Exa result", url: "", summary: rawText.slice(0, 900), content: rawText.slice(0, 8_000) }];
}

export function buildEvidenceContext(sources: WebSource[]) {
  return sources.map((source, index) => {
    const body = (source.content || source.summary || "").slice(0, 5_000);
    return `[${index + 1}] ${source.title}\nURL: ${source.url || "N/A"}\n${body}`;
  }).join("\n\n---\n\n");
}

export async function searchWeb(query: string, numResults = 6, signal?: AbortSignal) {
  const session = await openMcpSession(signal);
  const data = await callTool(session, "web_search_exa", { query, numResults: Math.min(Math.max(numResults, 3), 10), type: "auto" }, signal);
  const text = partsToText(data);
  if (!text) throw new Error("Exa returned no searchable content");
  const sources = normalizeSources(text);
  return { content: buildEvidenceContext(sources), sources };
}

export async function fetchUrls(urls: string[], signal?: AbortSignal) {
  const clean = Array.from(new Set(urls.map((url) => safePublicHttpUrl(url)).filter((url): url is string => Boolean(url)))).slice(0, 5);
  if (!clean.length) throw new Error("Missing valid public URLs");
  const session = await openMcpSession(signal);

  try {
    const data = await callTool(session, "web_fetch_exa", { urls: clean }, signal);
    const text = partsToText(data);
    if (!text) throw new Error("Exa returned no URL content");
    const parsed = normalizeSources(text);
    const sources = parsed.length === 1 && !parsed[0].url && clean.length === 1
      ? [{ ...parsed[0], title: clean[0], url: clean[0] }]
      : parsed;
    return { content: buildEvidenceContext(sources), sources };
  } catch (error) {
    if (signal?.aborted) throw error;
    const sources: WebSource[] = [];
    for (let index = 0; index < clean.length; index += 1) {
      const data = await callTool(session, "web_fetch_exa", { url: clean[index] }, signal, index + 3);
      const text = partsToText(data);
      sources.push({ title: clean[index], url: clean[index], content: text.slice(0, 14_000), summary: text.slice(0, 700).replace(/\s+/g, " ") });
    }
    return { content: buildEvidenceContext(sources), sources };
  }
}
