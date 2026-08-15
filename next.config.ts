import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  // 原生依赖保持运行时 require：@napi-rs/canvas 的 .node 资产无法进 Turbopack ESM chunk（PDF 页渲染链）。
  // pdfjs-dist：其 fake-worker 动态 import pdf.worker.mjs 相对路径，打包内联后文件不存在（Node 24 动态 import ESM 原生可用）。
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
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
