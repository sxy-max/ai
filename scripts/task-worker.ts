/** Task Worker 进程入口：npm run task-worker（compose 中独立 service，PRD §77 worker）。 */
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
import { runTaskWorkerLoop } from "../lib/tasks/worker";

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

void runTaskWorkerLoop({ signal: controller.signal });
