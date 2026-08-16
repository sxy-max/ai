#!/bin/sh
# 部署 file-agent 容器升级（directive/MCP/repair 支持）。
# 用法：ssh tencent-ai 'bash -s' < scripts/file-agent/deploy.sh
set -e

# 1. 更新 agent.mjs（directive/repair/previous 进 CLAUDE.md + vision MCP 挂载）
sudo docker cp scripts/file-agent/agent.mjs go-ai-file-agent:/app/agent.mjs
echo "agent.mjs updated"

# 2. 更新 vision-mcp（stdio MCP 服务器 → vision-gateway）
sudo docker exec go-ai-file-agent sh -c 'rm -rf /app/vision-mcp'
sudo docker cp scripts/file-agent/vision-mcp go-ai-file-agent:/app/vision-mcp
# 依赖安装（容器内 npm；离线时用本地 node_modules 直接拷入）
if sudo docker exec go-ai-file-agent sh -c 'test -d /app/vision-mcp/node_modules/@modelcontextprotocol' 2>/dev/null; then
  echo "vision-mcp deps present"
else
  sudo docker exec go-ai-file-agent sh -c 'cd /app/vision-mcp && npm install --omit=dev 2>&1 | tail -2' || {
    echo "npm install failed in container; copying local node_modules"
    sudo docker cp scripts/file-agent/vision-mcp/node_modules go-ai-file-agent:/app/vision-mcp/node_modules 2>/dev/null || echo "no local node_modules — run: cd scripts/file-agent/vision-mcp && npm install"
  }
fi
sudo docker exec go-ai-file-agent sh -c 'node -e "require(\"/app/vision-mcp/node_modules/@modelcontextprotocol/sdk/package.json\"); console.log(\"vision-mcp sdk ok\")" 2>/dev/null || echo "VISION_MCP_SDK_MISSING"'

# 3. 容器环境补 vision gateway 地址（如有则注入；缺省走 go-ai-net 服务名）
# 4. 重启容器（agent.mjs 变更生效；容器文件系统保留）
sudo docker restart go-ai-file-agent
sleep 4
sudo docker exec go-ai-file-agent sh -c 'curl -s http://127.0.0.1:18082/health 2>/dev/null || node -e "fetch(\"http://127.0.0.1:18082/health\").then(r=>r.json()).then(j=>console.log(\"health:\",JSON.stringify(j))).catch(e=>console.log(\"ERR\",e.message))"'
echo "file-agent restarted"
