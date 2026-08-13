// 预热 Next dev 编译，避免 Turbopack 对并行首次编译返回 403/挂起。
// 生产(next start/Docker)不受影响；这是 dev 基础设施的已知竞态。
export default async function globalSetup() {
  const base = "http://127.0.0.1:3000";
  const paths = ["/", "/api/auth", "/api/models"];
  for (const path of paths) {
    try {
      await fetch(base + path, { method: path === "/api/auth" ? "POST" : "GET" });
    } catch {
      // 预热失败不致命，测试仍会尝试
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // 让 Turbopack 把 chunk 编译完，再开始测试
  await new Promise((r) => setTimeout(r, 4000));
}
