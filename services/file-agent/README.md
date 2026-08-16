# Go AI File Agent — Claude Code 主 Harness 执行容器

Go AI 唯一主执行体的容器定义（本 Goal）。与既有 `go-ai-file-agent` 容器契约兼容。

## 职责

- **执行体**：容器内 Claude Code（headless CLI）完成一切智能工作——理解/规划/执行/观察/修改/自验证。
- **工具箱**：按 Preflight Execution Directive 挂载 MCP：
  | MCP | 工具 | 实现 |
  |---|---|---|
  | vision | vision.inspect/read/compare/locate | `mcp/vision-mcp/server.js`（拷贝自 claude-vision-mcp；经 vision-gateway → MiniMax M3，图片内容 UNTRUSTED） |
  | browser | browser.navigate/read_page/click/type/scroll/screenshot/download/back | `mcp/browser-mcp.mjs`（playwright-core + 系统 chromium，DOM 优先） |
  | office | office.presentation/spreadsheet/document/pdf/validate | `mcp/office-mcp.mjs`（复用 go-ai `lib/generators`：pptxgenjs/exceljs/docx/chromium-PDF，真实物理格式） |
  | search | search.web_search/web_fetch | `mcp/search-mcp.mjs`（复用 `lib/exa.ts`） |
- **契约**：
  - `GET /health` → 就绪探测
  - `POST /task` → NDJSON 事件流（agent_tool/agent_text/agent_result/artifacts/done/agent_error）
    payload 兼容既有字段（conversationId/jobId/prompt/maxTurns/model/gatewayBaseUrl/gatewayToken/visionMd/memory/style/skills）
    + 本 Goal 新增：`directive`（Preflight 指令：mainModel/mcpServers/deliveryContract…）、`repair`（Validation 证据回交）、`continueSession`
- **workspace**：`{conversationId}/{jobId}`（挂载卷 /data/workspaces；与 Go AI 任务系统共享）
- **模型/凭证**：真实 key 只在 cc-auth-gateway；容器内 `ANTHROPIC_BASE_URL` 指向网关、`ANTHROPIC_MODEL` 由 directive.mainModel 决定

## 构建（本地验证后）

```bash
cd /d/Projects/go-ai
docker build -t go-ai-file-agent:claude -f services/file-agent/Dockerfile .
```

本地 MCP bundle 构建链验证：`bash scripts/verify-file-agent-bundle.sh`（模拟 /app 布局，同款 esbuild 命令）。

## 部署（tencent-ai，替换既有 go-ai-file-agent）

```bash
docker save go-ai-file-agent:claude -o /tmp/file-agent.tar
scp /tmp/file-agent.tar tencent-ai:/tmp/
ssh tencent-ai "sudo docker load -i /tmp/file-agent.tar
  sudo docker rm -f go-ai-file-agent
  sudo docker run -d --name go-ai-file-agent --network go-ai-net --restart unless-stopped \
    -v /opt/ai-client/data/workspaces:/data/workspaces \
    -e AGENT_PORT=18082 -e AGENT_MODEL=deepseek-v4-flash \
    -e CC_GATEWAY_URL=http://cc-auth-gateway:18081 \
    -e VISION_GATEWAY_URL=http://vision-gateway:19090 \
    -e VISION_GATEWAY_TOKEN=<来自 /opt/vision-gateway/.token> \
    go-ai-file-agent:claude"
```

回滚：`go-ai-file-agent` 旧镜像（go-ai-file-agent:latest 或备份标签）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| AGENT_PORT | 18082 | HTTP 端口 |
| AGENT_MODEL | deepseek-v4-flash | 未指定 directive 时的主模型 |
| CC_GATEWAY_URL | http://cc-auth-gateway:18081 | Claude Code 的 ANTHROPIC_BASE_URL（真实 key 在网关） |
| VISION_GATEWAY_URL / VISION_GATEWAY_TOKEN | vision-gateway:19090 / 空 | vision-mcp 的网关 |
| EXA_API_KEY | 空 | search-mcp（公开端点可匿名） |
| WORKSPACES_ROOT | /data/workspaces | 共享工作区挂载 |
