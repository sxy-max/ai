/** CLI：npm run db:migrate —— 应用 schema 到 DATABASE_URL 指定的库。 */
import { loadEnvFile } from "node:process";
try {
  loadEnvFile(".env.local");
} catch {
  // 无 .env.local（如生产容器用 env-file 注入）时忽略
}

import { migrate } from "../lib/db/migrate";

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[db] migrate failed:", err);
    process.exit(1);
  });
