/** PostgreSQL 连接池（产品真实状态源，PRD §61）。 */

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

let pool: Pool | null = null;

export function dbUrl() {
  return process.env.DATABASE_URL || "postgres://goai:goai@127.0.0.1:5432/go_ai";
}

export function dbPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: dbUrl(),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });
    pool.on("error", (err) => {
      // 空闲客户端错误不应当让进程崩溃；打印后靠下次查询重建
      console.error("[db] idle client error:", err.message);
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return dbPool().query<T>(text, params);
}

/** 关闭连接池（测试/CLI 退出用；否则空闲句柄让进程挂住）。 */
export async function closeDb() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
}

/** 事务执行器：callback 内用提供的 client 执行全部语句，异常整体回滚。 */
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await dbPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
