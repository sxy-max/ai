import http from "node:http";
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
const UPSTREAM = "https://opencode.ai/zen/go/v1";
const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  console.log("=== REQ", req.method, req.url, "===");
  console.log(body.slice(0, 1500));
  console.log("=== END ===");
  const upstream = await fetch(`${UPSTREAM}${req.url}`, {
    method: req.method,
    headers: { "content-type": "application/json", authorization: req.headers.authorization || "" },
    body: body || undefined,
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, { "content-type": "application/json" });
  res.end(text);
});
server.listen(8099, "127.0.0.1", () => console.log("proxy on 8099"));
