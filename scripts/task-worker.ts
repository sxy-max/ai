/** Task Worker 进程入口：npm run task-worker（compose 中独立 service，PRD §77 worker）。 */
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
import { runTaskWorkerLoop } from "../lib/tasks/worker";
import { startProviderProbeLoop } from "../lib/policy/providerProbe";

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

// V1.3 WP23：Provider 后台探测（10 分钟间隔；模型选择自动避开不可用）
const defaultModels = (process.env.FEATURED_MODELS || "deepseek-v4-pro,deepseek-v4-flash,kimi-k3,qwen3.8-max,glm-5.2,minimax-m3,gpt-5.6-luna,grok-4.5")
  .split(",").map((m) => m.trim()).filter(Boolean);
startProviderProbeLoop(() => defaultModels, () => process.env.OPENCODE_GO_API_KEY || "", controller.signal);
console.log("[task-worker] provider probe loop started");

void runTaskWorkerLoop({ signal: controller.signal });
