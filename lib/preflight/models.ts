/**
 * 主模型 Auto 解析（本 Goal D4/D33）：任务能力 → 批准模型池 → Provider 健康 → 配额 →
 * Claude Code 兼容 → 主模型 + fallback 链。
 *
 * 原则：
 * - 默认 Auto（用户不感知模型差异）
 * - Coding/Workspace 默认 DeepSeek V4 Flash（现有资产，除非 Harness Benchmark 证明替代者）
 * - MiniMax 是 Vision Specialist，绝不选为主模型（视觉经 vision-mcp 进入）
 * - 健康/配额参与：provider 坏或额度尽则跳过，不硬选
 * - fallback 在同一工作环境切换，不重开空任务
 */

import { selectModel } from "../policy/modelPolicy";
import { ProviderHealthRegistry } from "../policy/providerHealth";
import { quotaCheck } from "../quota";
import type { DirectiveCapability } from "./directive";

export type MainModelSelection = {
  mainModel: string;
  fallbackModels: string[];
  reason: string;
};

const FLASH = "deepseek-v4-flash";
const PRO = "deepseek-v4-pro";
const KIMI = "kimi-k3";
const GLM = "glm-5.2";
const QWEN = "qwen3.8-max";

const APPROVED_POOL = [FLASH, PRO, KIMI, GLM, QWEN];

export type AutoModelInput = {
  capabilities: DirectiveCapability[];
  reasoning: "none" | "auto" | "high";
  health?: ProviderHealthRegistry;
  availableModels?: string[];
  configuredAgentModel?: string;
};

/** 过滤健康模型：disabled / region_unavailable 直接排除；degraded 排在最后。 */
function healthyModels(models: string[], health?: ProviderHealthRegistry): { ready: string[]; degraded: string[] } {
  if (!health) return { ready: [...models], degraded: [] };
  const ready: string[] = [];
  const degraded: string[] = [];
  for (const m of models) {
    const status = health.statusOf(m);
    if (status === "available" || status === "degraded") (status === "degraded" ? degraded : ready).push(m);
    // temporary_unavailable / region_unavailable / disabled → 排除
  }
  return { ready, degraded };
}

/**
 * 主模型 Auto。返回 null 表示池内无健康模型（调用方给出明确错误，不随机替换）。
 */
export async function resolveMainModel(input: AutoModelInput): Promise<MainModelSelection | null> {
  const pool = (input.availableModels?.length ? input.availableModels : APPROVED_POOL).filter((m) => APPROVED_POOL.includes(m));
  const { ready, degraded } = healthyModels(pool, input.health);
  const usable = [...ready, ...degraded];
  if (!usable.length) return null;

  const caps = input.capabilities;
  const isWorkspaceHeavy = caps.includes("coding") || caps.includes("browser");
  const role = input.reasoning === "high" ? "reasoning" : isWorkspaceHeavy ? "agent" : "chat";

  // 用户/系统显式覆盖（env AGENT_MODEL 等）优先，但必须健康且在批准池
  const configured = input.configuredAgentModel;
  if (configured && usable.includes(configured)) {
    return { mainModel: configured, fallbackModels: chainFor(role).filter((m) => m !== configured && usable.includes(m)), reason: `configured agent model: ${configured}` };
  }

  const chain = chainFor(role).filter((m) => usable.includes(m));
  if (!chain.length) return null;

  // 配额检查（异步；失败仅记录，不阻塞主链——配额由控制面 enforce）
  const picked = chain[0];
  try {
    const status = await quotaCheck(picked);
    if (!status.ok) {
      const alt = chain.slice(1).find((m) => m !== picked);
      if (alt) return { mainModel: alt, fallbackModels: chain.filter((m) => m !== alt), reason: `quota denied ${picked}, fallback ${alt}` };
    }
  } catch {}

  return { mainModel: picked, fallbackModels: chain.slice(1), reason: `auto: ${role} chain → ${picked}` };
}

function chainFor(role: "agent" | "chat" | "reasoning"): string[] {
  switch (role) {
    case "agent": return [FLASH, KIMI, PRO];      // Coding/Workspace 主力
    case "reasoning": return [PRO, QWEN, GLM, FLASH];
    case "chat": return [FLASH, KIMI, GLM];
  }
}

/** 兼容入口：同步版本（无 health/quota 时；测试用）。 */
export function resolveMainModelSync(capabilities: DirectiveCapability[], reasoning: "none" | "auto" | "high"): string {
  const role = reasoning === "high" ? "reasoning" : capabilities.includes("coding") || capabilities.includes("browser") ? "agent" : "chat";
  return chainFor(role)[0];
}
