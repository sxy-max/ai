import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 90_000,
  use: {
    // 3100：避免与本地 ai-client 容器（127.0.0.1:3000）冲突
    baseURL: "http://127.0.0.1:3100",
  },
  webServer: {
    // dev 模式（E2E 放行要求 NODE_ENV !== production）+ 独立 dist（避免与 3000 dev 争锁）
    command: "npx next dev -p 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      E2E_MODE: "1",
      NEXT_PUBLIC_E2E_MODE: "1",
      NEXT_E2E: "1",
    },
  },
});
