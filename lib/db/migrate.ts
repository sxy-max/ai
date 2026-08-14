/**
 * Schema 迁移执行器：读取 lib/db/schema.sql（幂等 DDL），
 * 在 schema_migrations 表记录已应用版本，重复执行安全。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dbPool } from "./pool";

export const SCHEMA_VERSION = "v1.0";

export async function migrate() {
  const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
  const client = await dbPool().connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
    );
    const applied = await client.query("SELECT version FROM schema_migrations");
    const versions = new Set(applied.rows.map((r) => r.version));
    if (versions.has(SCHEMA_VERSION)) {
      console.log("[db] schema already applied:", SCHEMA_VERSION);
      return;
    }
    await client.query("BEGIN");
    try {
      for (const statement of splitStatements(sql)) {
        if (!statement.trim()) continue;
        await client.query(statement);
      }
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
        [SCHEMA_VERSION]
      );
      await client.query("COMMIT");
      console.log("[db] schema applied:", SCHEMA_VERSION);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}

/** 按分号切分 SQL（忽略注释行内的分号——本 schema 无函数体，简单实现足够）。 */
function splitStatements(sql: string): string[] {
  const lines = sql.split("\n");
  const statements: string[] = [];
  let current = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("--")) continue;
    current += line + "\n";
    if (line.trimEnd().endsWith(";")) {
      statements.push(current);
      current = "";
    }
  }
  if (current.trim()) statements.push(current);
  return statements;
}
