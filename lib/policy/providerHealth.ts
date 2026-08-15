/**
 * ProviderHealthRegistry（V1.2 WP18）：模型可用性状态集中管理。
 * 不等到用户请求失败才知道模型不可用；状态来自配置/探测/错误记录。
 * 状态机：available → degraded → temporary_unavailable → region_unavailable / disabled。
 */

export type ProviderStatus = "available" | "degraded" | "temporary_unavailable" | "region_unavailable" | "disabled";

export type ProviderProbeRecord = {
  status: ProviderStatus;
  errorCode?: string;
  errorBody?: string;
  endpoint?: string;
  probedAt: number;
  note?: string;
};

/** 内置已知状态（研究路径保留：Luna 区域受限；Grok 禁用）。 */
const BUILTIN: Record<string, ProviderStatus> = {
  "gpt-5.6-luna": "region_unavailable",
  "grok-4.5": "disabled",
};

export class ProviderHealthRegistry {
  private records = new Map<string, ProviderProbeRecord>();
  private probes = new Map<string, number>(); // model -> last probe ts

  constructor(private readonly probeTtlMs = 5 * 60 * 1000) {}

  /** 当前状态：产品硬禁用（disabled）永远优先；其次探测记录；其次内置；默认 available。 */
  statusOf(model: string): ProviderStatus {
    if (BUILTIN[model] === "disabled") return "disabled"; // 产品硬禁用（UI 不展示）
    const record = this.records.get(model);
    if (record) return record.status;
    return BUILTIN[model] || "available";
  }

  isAvailable(model: string): boolean {
    return this.statusOf(model) === "available";
  }

  /** 记录一次探测/失败结果。 */
  record(model: string, probe: ProviderProbeRecord): void {
    this.records.set(model, probe);
    this.probes.set(model, probe.probedAt);
  }

  /** 记录一次调用失败（状态机降级：available → degraded；degraded 持续失败 → temporary_unavailable）。 */
  recordFailure(model: string, errorCode: string, errorBody?: string, endpoint?: string): ProviderStatus {
    const current = this.statusOf(model);
    let next: ProviderStatus;
    if (current === "available" || current === "degraded") next = "degraded";
    else if (current === "temporary_unavailable") next = "temporary_unavailable";
    else next = current; // region_unavailable / disabled 不因单次失败改变
    const record: ProviderProbeRecord = { status: next, errorCode, errorBody: errorBody?.slice(0, 500), endpoint, probedAt: Date.now() };
    this.records.set(model, record);
    this.probes.set(model, record.probedAt);
    return next;
  }

  /** 探测新鲜度（过期则允许重新探测）。 */
  shouldProbe(model: string, now = Date.now()): boolean {
    const last = this.probes.get(model);
    return last == null || now - last > this.probeTtlMs;
  }

  /** 可用模型过滤（供 ModelPolicyEngine 使用）。 */
  availableModels(all: string[]): string[] {
    return all.filter((m) => this.isAvailable(m));
  }

  snapshot(): Record<string, ProviderStatus> {
    const out: Record<string, ProviderStatus> = {};
    for (const model of new Set([...this.records.keys(), ...Object.keys(BUILTIN)])) {
      out[model] = this.statusOf(model);
    }
    return out;
  }
}

/** 全局实例（Worker/API 共用）。 */
export const providerHealthRegistry = new ProviderHealthRegistry();

/** 真实 provider 探测：对 opencode 通道发最小请求，记录错误码/body 与 endpoint（Luna 根因调查用）。 */
export async function probeModel(model: string, apiKey: string): Promise<ProviderProbeRecord> {
  const registry = providerHealthRegistry;
  const endpoint = `${(process.env.OPENCODE_GO_BASE_URL || "https://opencode.ai/zen/go/v1").replace(/\/+$/, "")}/chat/completions`;
  const probedAt = Date.now();
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "x-api-key": apiKey },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (resp.ok) {
      const record: ProviderProbeRecord = { status: "available", probedAt, endpoint, note: "probe 200" };
      registry.record(model, record);
      return record;
    }
    const body = (await resp.text().catch(() => "")).slice(0, 500);
    const isRegion = /region|area|location|地域|地区|不可用|not available/i.test(body) || resp.status === 403;
    const status: ProviderStatus = isRegion ? "region_unavailable" : "temporary_unavailable";
    const record: ProviderProbeRecord = { status, errorCode: `HTTP_${resp.status}`, errorBody: body, endpoint, probedAt };
    registry.record(model, record);
    return record;
  } catch (error) {
    const record: ProviderProbeRecord = {
      status: "temporary_unavailable",
      errorCode: error instanceof Error ? error.name : "NETWORK",
      errorBody: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      endpoint,
      probedAt,
    };
    registry.record(model, record);
    return record;
  }
}
