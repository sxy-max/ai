/**
 * Chromium 解析工具（V1.4 WP49）：PDF 渲染 / Browser Runtime 共享。
 * 优先系统 chromium（Dockerfile 已 apk 安装），否则 playwright 自带浏览器（本地）。
 * 服务器无 playwright 浏览器缓存 → 系统 chromium 是 PDF/浏览器能力的云端路径。
 */
import fs from "node:fs";

const SYSTEM_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/local/bin/chromium",
  "/usr/bin/chromium.chromium",
];

/** 系统 chromium 可执行路径（无则 undefined → playwright 自带）。 */
export function systemChromiumPath(): string | undefined {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim();
  if (fromEnv) return fromEnv;
  for (const p of SYSTEM_PATHS) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return undefined;
}

/** chromium.launch 参数（带 executablePath 时注入）。 */
export function launchOptions(base: { headless: boolean }): { headless: boolean; executablePath?: string } {
  const path = systemChromiumPath();
  return path ? { ...base, executablePath: path } : base;
}
