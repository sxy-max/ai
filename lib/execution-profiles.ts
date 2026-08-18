import {
  providerHealthRegistry,
  type ProviderProbeRecord,
  type ProviderStatus,
} from "./policy/providerHealth";

export type RuntimeExecutionProfileId = "deepseek-flash" | "gpt-luna";
export type ExecutionProfileChoice = "auto" | RuntimeExecutionProfileId;
export type ExecutionProfileStatus =
  | "healthy"
  | "checking"
  | "credential_missing"
  | "auth_failed"
  | "region_limited"
  | "upstream_unavailable"
  | "maintenance";

export type ExecutionProfile = {
  id: string;
  name: string;
  model: string;
  baseUrl: string | null;
  purpose: string;
  status: ExecutionProfileStatus;
  statusLabel: string;
  displayStatus: string;
  detail: string;
  runtimeSelectable: boolean;
  autoRouting: boolean;
  lastCheckedAt: number | null;
  maintenance: boolean;
};

const FLASH = "deepseek-v4-flash";
const LUNA = "gpt-5.6-luna";
// CC Switch's saved profiles and the live provider both use this hostname. The
// one-o variant from the pasted brief does not serve the API.
export const CLAUDE_PROFILE_BASE_URL = "https://api.maolaoapi.cc/v1";
const ENABLED_ENV = "CLAUDE_RUNTIME_PROFILES_ENABLED";

const ACTIVE_PROFILES: ReadonlyArray<{
  id: RuntimeExecutionProfileId;
  name: string;
  model: string;
  purpose: string;
}> = [
  {
    id: "deepseek-flash",
    name: "DeepSeek V4 Flash",
    model: FLASH,
    purpose: "Coding / Workspace / Project / File / Tool-heavy",
  },
  {
    id: "gpt-luna",
    name: "GPT 5.6 Luna",
    model: LUNA,
    purpose: "General / Reasoning / Research / User-facing explanation",
  },
];

function enabledProfileIds(): Set<string> {
  if (process.env.E2E_MODE === "1") return new Set(ACTIVE_PROFILES.map((profile) => profile.id));
  return new Set((process.env[ENABLED_ENV] || "").split(",").map((value) => value.trim()).filter(Boolean));
}

function statusFromProbe(probe: ProviderProbeRecord | undefined): ExecutionProfileStatus {
  if (!probe) return "checking";
  if (probe.status === "available" || probe.status === "degraded") return "healthy";
  if (probe.status === "region_unavailable") return "region_limited";
  if (probe.errorCode === "HTTP_401" || probe.errorCode === "HTTP_403") return "auth_failed";
  return "upstream_unavailable";
}

function statusCopy(status: ExecutionProfileStatus) {
  switch (status) {
    case "healthy": return { label: "可用", detail: "最近一次 Claude Runtime 健康检查通过。" };
    case "checking": return { label: "待检测", detail: "尚无新 Runtime Profile 的健康检查结果。" };
    case "credential_missing": return { label: "缺少凭证", detail: "服务器尚未启用与此 Profile 匹配的凭证。" };
    case "auth_failed": return { label: "认证失败", detail: "服务端凭证被上游拒绝；该 Profile 不会参与执行。" };
    case "region_limited": return { label: "区域限制", detail: "最近检查触发地区限制；Auto 会回退到 DeepSeek V4 Flash。" };
    case "upstream_unavailable": return { label: "上游不可用", detail: "最近检查未通过；该 Profile 暂不参与执行。" };
    case "maintenance": return { label: "待维修", detail: "历史配置仅保留诊断记录，不可选择，也不参与 Auto Routing。" };
  }
}

export function executionProfiles(): ExecutionProfile[] {
  const enabled = enabledProfileIds();
  const active = ACTIVE_PROFILES.map((definition): ExecutionProfile => {
    const probe = providerHealthRegistry.latestProbeOf(definition.model);
    const status = enabled.has(definition.id) ? statusFromProbe(probe) : "credential_missing";
    const copy = statusCopy(status);
    const usable = status === "healthy";
    return {
      ...definition,
      baseUrl: CLAUDE_PROFILE_BASE_URL,
      status,
      statusLabel: copy.label,
      displayStatus: copy.label,
      detail: copy.detail,
      runtimeSelectable: usable,
      autoRouting: usable,
      lastCheckedAt: probe?.probedAt ?? null,
      maintenance: false,
    };
  });

  const maintenanceCopy = statusCopy("maintenance");
  return [
    ...active,
    {
      id: "legacy-deepseek-gateway",
      name: "旧 DeepSeek Runtime",
      model: "deepseek-v4-pro",
      baseUrl: null,
      purpose: "被新 DeepSeek V4 Flash Profile 替代",
      status: "maintenance",
      statusLabel: maintenanceCopy.label,
      displayStatus: maintenanceCopy.label,
      detail: maintenanceCopy.detail,
      runtimeSelectable: false,
      autoRouting: false,
      lastCheckedAt: null,
      maintenance: true,
    },
    {
      id: "legacy-luna-region",
      name: "旧 Luna Runtime",
      model: LUNA,
      baseUrl: null,
      purpose: "被新 GPT 5.6 Luna Profile 替代",
      status: "maintenance",
      statusLabel: maintenanceCopy.label,
      displayStatus: maintenanceCopy.label,
      detail: maintenanceCopy.detail,
      runtimeSelectable: false,
      autoRouting: false,
      lastCheckedAt: null,
      maintenance: true,
    },
  ];
}

export function isExecutionProfileChoice(value: unknown): value is ExecutionProfileChoice {
  return value === "auto" || value === "deepseek-flash" || value === "gpt-luna";
}

export function runtimeProfileIdForModel(model: string): RuntimeExecutionProfileId | undefined {
  if (model === FLASH) return "deepseek-flash";
  if (model === LUNA) return "gpt-luna";
  return undefined;
}

export function executionProfileModel(id: ExecutionProfileChoice | undefined): string | undefined {
  if (!id || id === "auto") return undefined;
  const profile = executionProfiles().find((item) => item.id === id);
  return profile?.runtimeSelectable ? profile.model : undefined;
}

function probeStatus(response: Response, body: string): ProviderStatus {
  if (response.ok) return "available";
  if (response.status === 403 && /region|area|location|地域|地区|不可用|not available/i.test(body)) return "region_unavailable";
  return "temporary_unavailable";
}

async function probeRuntimeModel(model: string): Promise<ProviderProbeRecord> {
  const endpoint = `${(process.env.AGENT_GATEWAY_URL || "http://cc-auth-gateway:18081").replace(/\/+$/, "")}/v1/messages`;
  const probedAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "go-ai-runtime-probe" },
      body: JSON.stringify({
        model,
        max_tokens: 8,
        stream: false,
        messages: [{ role: "user", content: "Reply OK." }],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.text().catch(() => "")).slice(0, 500);
    return {
      status: probeStatus(response, body),
      ...(response.ok ? { note: "Claude Runtime probe 200" } : { errorCode: `HTTP_${response.status}`, errorBody: body }),
      endpoint,
      probedAt,
    };
  } catch (error) {
    return {
      status: "temporary_unavailable",
      errorCode: error instanceof Error ? error.name : "NETWORK",
      errorBody: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      endpoint,
      probedAt,
    };
  }
}

/** Probe the actual Claude-compatible gateway. Secrets remain inside that gateway. */
export async function probeExecutionProfiles(force = false): Promise<ExecutionProfile[]> {
  const enabled = enabledProfileIds();
  await Promise.all(ACTIVE_PROFILES.map(async (definition) => {
    if (!enabled.has(definition.id)) return;
    if (!force && !providerHealthRegistry.shouldProbe(definition.model)) return;
    providerHealthRegistry.record(definition.model, await probeRuntimeModel(definition.model));
  }));
  return executionProfiles();
}

export async function availableRuntimeModels(): Promise<string[]> {
  await probeExecutionProfiles();
  return executionProfiles()
    .filter((profile) => !profile.maintenance && profile.autoRouting)
    .map((profile) => profile.model);
}
