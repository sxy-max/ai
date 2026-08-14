/** User 数据访问（PRD §73 注册/登录）。 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { query } from "./pool";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string,
  keylen: number
) => Promise<Buffer>;

export type UserRow = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: Date;
  updated_at: Date;
};

const SCRYPT_KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hex] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hex) return false;
  const expected = Buffer.from(hex, "hex");
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return expected.byteLength === derived.byteLength && timingSafeEqual(expected, derived);
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const result = await query<UserRow>("SELECT * FROM users WHERE email = $1", [email.trim().toLowerCase()]);
  return result.rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const result = await query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function createUser(input: {
  email: string;
  displayName: string;
  password: string;
  role?: string;
}): Promise<UserRow> {
  const passwordHash = await hashPassword(input.password);
  const result = await query<UserRow>(
    `INSERT INTO users (email, display_name, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.email.trim().toLowerCase(), input.displayName.trim() || "用户", passwordHash, input.role || "user"]
  );
  return result.rows[0];
}

/** 首个注册用户成为 admin（单机私有部署的引导方式）。 */
export async function userCount(): Promise<number> {
  const result = await query<{ count: string }>("SELECT count(*)::text AS count FROM users");
  return Number(result.rows[0]?.count ?? 0);
}

export function publicUser(user: UserRow) {
  return { id: user.id, email: user.email, display_name: user.display_name, role: user.role };
}
