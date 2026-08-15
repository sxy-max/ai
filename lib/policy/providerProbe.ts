/**
 * Provider Health 后台探测（V1.3 WP23）：异步 probe + Redis 持久化。
 * 不再每次打开页面探测；每 5-10 分钟探测一次，/api/models 直读结果。
 * 模型选择自动避开 unavailable / region_blocked。
 */

import { providerHealthRegistry, probeModel, type ProviderProbeRecord, type ProviderStatus } from "./providerHealth";
import { redis } from "../db/redis";

const PROBE_INTERVAL_MS = 10 * 60 * 1000;
const PROBE_KEY = "go-ai:provider-health";

export type ProbeSummary = ProviderProbeRecord & { model: string };

/** 写入 Redis（web/worker 共享）。 */
export async function persistProbeResults(records: ProbeSummary[]): Promise<void> {
  try {
    const client = redis();
    if (client) await client.set(PROBE_KEY, JSON.stringify(records), "EX", 30 * 60);
  } catch {}
}

/** 从 Redis 读 probe 结果（空 → 无缓存）。 */
export async function readProbeResults(): Promise<ProbeSummary[]> {
  try {
    const client = redis();
    if (!client) return [];
    const raw = await client.get(PROBE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ProbeSummary[];
  } catch {
    return [];
  }
}

/** 一轮探测：给定模型列表 → probe → 更新 registry + 持久化。 */
export async function runProviderProbeRound(models: string[], apiKey: string): Promise<ProbeSummary[]> {
  const summaries: ProbeSummary[] = [];
  for (const model of models) {
    // 产品硬禁用（grok）跳过；已 region_unavailable 且 TTL 内跳过（避免高频探测）
    const current = providerHealthRegistry.statusOf(model);
    if (current === "disabled") continue;
    if (current === "region_unavailable" && !providerHealthRegistry.shouldProbe(model)) continue;
    const record = await probeModel(model, apiKey);
    summaries.push({ model, ...record });
  }
  await persistProbeResults(summaries);
  return summaries;
}

/** worker 侧后台循环（10 分钟间隔；阻塞调用方直到 abort）。 */
export function startProviderProbeLoop(getModels: () => string[], getApiKey: () => string, signal?: AbortSignal): { stop: () => void } {
  const run = () => {
    void runProviderProbeRound(getModels(), getApiKey()).catch(() => {});
  };
  run();
  const timer = setInterval(run, PROBE_INTERVAL_MS);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  if (signal) {
    signal.addEventListener("abort", stop, { once: true });
  }
  return { stop };
}

/** 模型 → 状态（registry 优先，Redis 缓存次之，默认 available）。 */
export async function providerStatusOf(model: string): Promise<ProviderStatus> {
  const current = providerHealthRegistry.statusOf(model);
  if (current !== "available") return current;
  const cached = await readProbeResults();
  const hit = cached.find((r) => r.model === model);
  return hit?.status || "available";
}

/** 合并 probe 缓存进 registry（web 进程读 Redis 后同步到内存）。 */
export function applyProbeCacheToRegistry(records: ProbeSummary[]): void {
  for (const record of records) {
    providerHealthRegistry.record(record.model, record);
  }
}
