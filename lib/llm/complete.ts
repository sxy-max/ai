/**
 * LLM 补全封装（非流式）：任务规划/内容生成/回答用。
 * Provider 优先级（WP7 Model Role 收敛，复用现有配置，不新增 key）：
 *   1. OpenCode Go 通道（OPENCODE_GO_API_KEY + PLANNER_MODEL，默认 deepseek-v4-pro）
 *   2. DeepSeek 官方直连（DEEPSEEK_API_KEY）
 * 均未配置时返回 null，调用方走确定性 fallback。
 */

import { timeoutSignal } from "../http";
import { API_ROOT } from "../opencode";

export type ChatRole = "system" | "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

export type CompleteOptions = {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  jsonMode?: boolean;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** 当前可用的 planner/content provider：opencode-go > deepseek > null。 */
export function configuredPlannerProvider(): "opencode-go" | "deepseek" | null {
  if (process.env.OPENCODE_GO_API_KEY?.trim()) return "opencode-go";
  if (process.env.DEEPSEEK_API_KEY?.trim()) return "deepseek";
  return null;
}

export async function completeChat(options: CompleteOptions): Promise<string | null> {
  const provider = configuredPlannerProvider();
  if (!provider) return null;
  if (provider === "opencode-go") return completeOpenCodeGo(options);
  return completeDeepseek(options);
}

/** OpenCode Go 通道（OpenAI 兼容 /chat/completions；模型默认 deepseek-v4-pro，PLANNER_MODEL 可覆盖）。 */
async function completeOpenCodeGo(options: CompleteOptions): Promise<string | null> {
  const apiKey = process.env.OPENCODE_GO_API_KEY?.trim();
  if (!apiKey) return null;
  const model = options.model || process.env.PLANNER_MODEL?.trim() || "deepseek-v4-pro";
  const timeout = timeoutSignal(options.signal, options.timeoutMs || 120_000);
  try {
    const response = await fetch(`${API_ROOT}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey
      },
      body: JSON.stringify({
        model,
        messages: options.messages,
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 2048,
        stream: false
      }),
      cache: "no-store",
      signal: timeout.signal
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      console.error(`[llm] opencode-go error ${response.status}:`, detail);
      return null;
    }
    const data = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content.trim() : null;
  } catch (error) {
    console.error("[llm] opencode-go request failed:", error instanceof Error ? error.message : error);
    return null;
  } finally {
    timeout.dispose();
  }
}

/** DeepSeek 官方直连（OpenAI 兼容；支持 response_format json_object）。 */
async function completeDeepseek(options: CompleteOptions): Promise<string | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  const baseUrl = process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com";
  if (!apiKey) return null;

  const model = options.model || process.env.DEEPSEEK_MODEL?.trim() || "deepseek-chat";
  const timeout = timeoutSignal(options.signal, options.timeoutMs || 120_000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: options.messages,
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 2048,
        stream: false,
        ...(options.jsonMode ? { response_format: { type: "json_object" } } : {})
      }),
      cache: "no-store",
      signal: timeout.signal
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      console.error(`[llm] deepseek error ${response.status}:`, detail);
      return null;
    }
    const data = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content.trim() : null;
  } catch (error) {
    console.error("[llm] deepseek request failed:", error instanceof Error ? error.message : error);
    return null;
  } finally {
    timeout.dispose();
  }
}

/** 从模型输出中提取 JSON（容错：允许 ```json 围栏、前后文字）。 */
export function extractJson<T>(text: string): T | null {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  for (const candidate of candidates) {
    // 尝试完整解析
    try { return JSON.parse(candidate) as T; } catch {}
    // 提取最外层 { } 或 [ ]
    const brace = candidate.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (brace) {
      try { return JSON.parse(brace[1]) as T; } catch {}
    }
    // 去掉尾逗号后重试
    try { return JSON.parse(candidate.replace(/,\s*([\]}])/g, "$1")) as T; } catch {}
  }
  return null;
}
