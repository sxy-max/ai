import { defineConfig } from "@playwright/test";

/** 独立运行配置：3200 端口，避免与本地 3000 dev / 3100 其他实例冲突。
 *  生产模式（next start）读取共享 .next 构建产物。 */
export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup.ts",
  timeout: 90_000,
  use: {
    baseURL: "http://127.0.0.1:3200",
  },
  webServer: {
    command: "npx next start -p 3200",
    url: "http://127.0.0.1:3200",
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      E2E_MODE: "1",
      NEXT_PUBLIC_E2E_MODE: "1",
    },
  },
});
