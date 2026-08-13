/**
 * 服务端模型参数策略（server-side capability / parameter policy）。
 * 不再假设所有模型支持同一套 temperature / reasoning 参数。
 */

export type TemperaturePolicy =
  | { mode: "fixed"; value: number }
  | { mode: "range"; min: number; max: number }
  | { mode: "unsupported" };

export type ReasoningPolicy = "instruct" | "none";

export type ModelPolicy = {
  temperature: TemperaturePolicy;
  reasoning: ReasoningPolicy;
};

const POLICIES: Record<string, ModelPolicy> = {
  // Kimi K3 上游只允许 temperature=1
  "kimi-k3": { temperature: { mode: "fixed", value: 1 }, reasoning: "instruct" },
};

export function modelPolicy(modelId: string): ModelPolicy {
  return POLICIES[modelId] || { temperature: { mode: "range", min: 0, max: 2 }, reasoning: "instruct" };
}

/**
 * 计算最终发送给上游的 temperature。
 * fixed -> 固定值（忽略客户端任何旧值，含 localStorage 残留）；
 * unsupported -> 不发送；
 * range -> 裁剪到 [min, max]。
 */
export function effectiveTemperature(model: string, requested?: number | null): number | undefined {
  const policy = modelPolicy(model);
  if (policy.temperature.mode === "fixed") return policy.temperature.value;
  if (policy.temperature.mode === "unsupported") return undefined;
  if (typeof requested !== "number" || !Number.isFinite(requested)) return undefined;
  return Math.min(Math.max(requested, policy.temperature.min), policy.temperature.max);
}
