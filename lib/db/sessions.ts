/** Session 数据访问：HttpOnly cookie token → user_id（PG 持久化，重启不丢）。 */

import { query, withTransaction } from "./pool";

export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export async function createSession(token: string, userId: string, ttlSeconds = SESSION_TTL_SECONDS) {
  await query(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (token) DO UPDATE SET expires_at = excluded.expires_at`,
    [token, userId, ttlSeconds]
  );
}

export async function findUserBySession(token: string): Promise<{ id: string } | null> {
  const result = await query<{ id: string }>(
    `SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now() AND u.status = 'active'`,
    [token]
  );
  return result.rows[0] ?? null;
}

export async function deleteSession(token: string) {
  await query("DELETE FROM sessions WHERE token = $1", [token]);
}

export async function deleteSessionsForUser(userId: string) {
  await query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

export async function touchSession(token: string) {
  // 滑动续期：每次访问顺延 TTL（最多每天刷新一次，避免写放大）
  await query(
    `UPDATE sessions
     SET expires_at = now() + make_interval(secs => $2)
     WHERE token = $1 AND expires_at > now() AND expires_at < now() + make_interval(hours => 1)`,
    [token, SESSION_TTL_SECONDS]
  );
}

/** 迁移用：把历史单密码会话按用户绑定（内部工具）。 */
export async function bindSessionToUser(token: string, userId: string) {
  await withTransaction(async (client) => {
    await client.query("DELETE FROM sessions WHERE token = $1", [token]);
    await client.query(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`,
      [token, userId, SESSION_TTL_SECONDS]
    );
  });
}
