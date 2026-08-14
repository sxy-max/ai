/**
 * Redis 客户端（PRD §62：Queue/Cache/Lock/Event/Realtime）。
 * 容错原则：Redis 是增强层，核心正确性由 PostgreSQL 保证。
 * 连接失败时任务系统仍可运行（PG 行级锁承担队列），Realtime 广播退化为轮询。
 */

import Redis from "ioredis";

let client: Redis | null = null;
let failed = false;

export function redisUrl() {
  return process.env.REDIS_URL || "redis://127.0.0.1:6379";
}

export function redis() {
  if (failed) return null;
  if (!client) {
    client = new Redis(redisUrl(), {
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
      lazyConnect: false
    });
    client.on("error", (err) => {
      if (!failed) console.error("[redis] error:", err.message);
      failed = true;
    });
    client.on("ready", () => {
      failed = false;
    });
  }
  return client;
}

/** 非阻塞发布任务事件（失败静默，事件持久化在 PG）。 */
export function publishTaskEvent(taskId: string, type: string, payload: Record<string, unknown>) {
  const r = redis();
  if (!r) return;
  r.publish(`task:events:${taskId}`, JSON.stringify({ type, payload })).catch(() => {});
}

/** 关闭 Redis 连接（测试/CLI 退出用；否则 ioredis socket 会让进程挂住）。 */
export async function closeRedis() {
  if (client) {
    try { client.disconnect(); } catch {}
    client = null;
  }
}
