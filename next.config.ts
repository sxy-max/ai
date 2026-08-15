import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  // 原生/浏览器依赖保持运行时 require：@napi-rs/canvas（.node 资产）、pdfjs-dist
  // （fake-worker 相对路径）、@playwright/test（PDF 渲染/Browser Runtime 的 chromium）
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist", "@playwright/test"],
  // Next 16 dev 默认阻止跨源 dev 资源；本地浏览器经 127.0.0.1/localhost 访问需显式放行
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
      ]
    }];
  }
};

export default nextConfig;
