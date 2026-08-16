# Go AI File Agent — Claude Code 主 Harness 执行容器（本 Goal 核心）
# 内容：Claude Code CLI + MCP 工具箱（vision/browser/office/search）+ /task 契约服务
# 复用：go-ai lib/generators（office-mcp）、lib/exa（search-mcp）、lib/browser 观察模型（browser-mcp）、
#       claude-vision-mcp（vision，经 vision-gateway → MiniMax）

FROM node:24-alpine

# 运行依赖：chromium（browser-mcp/office.pdf 用）、bash、工具链
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont bash curl unzip \
  && npm i -g @anthropic-ai/claude-code@latest \
  && npm cache clean --force

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# go-ai 仓库（office-mcp/search-mcp 复用 lib/generators + lib/exa + lib/artifacts）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY lib ./lib

# file-agent 本体 + MCP servers
COPY services/file-agent/agent.mjs ./agent.mjs
COPY services/file-agent/mcp ./mcp

# vision-mcp（独立包：@modelcontextprotocol/sdk + zod）
COPY services/file-agent/mcp/vision-mcp/package.json ./mcp/vision-mcp/package.json
COPY services/file-agent/mcp/vision-mcp/server.js ./mcp/vision-mcp/server.js
RUN cd /app/mcp/vision-mcp && npm ci --omit=dev

# office-mcp / browser-mcp / search-mcp 打包（TS 依赖 esbuild bundle；外部库运行时 require）
# stdin 入口 + cwd=/app：mcp 内 `../lib` 相对 /app 解析（本地验证同款命令，cwd=仓库根）
RUN echo 'import "./mcp/office-mcp.mjs"' | npx esbuild --bundle --platform=node --format=esm \
    --outfile=mcp/office-mcp.bundle.mjs \
    --external:playwright-core --external:xlsx --external:docx --external:pptxgenjs \
    --external:jszip --external:pdfjs-dist --external:@napi-rs/canvas \
  && echo 'import "./mcp/browser-mcp.mjs"' | npx esbuild --bundle --platform=node --format=esm \
    --outfile=mcp/browser-mcp.bundle.mjs --external:playwright-core \
  && echo 'import "./mcp/search-mcp.mjs"' | npx esbuild --bundle --platform=node --format=esm \
    --outfile=mcp/search-mcp.bundle.mjs --external:playwright-core \
  && rm mcp/office-mcp.mjs mcp/browser-mcp.mjs mcp/search-mcp.mjs mcp/mcp-lite.mjs
  && rm mcp/office-mcp.mjs mcp/browser-mcp.mjs mcp/search-mcp.mjs mcp/mcp-lite.mjs

# 非 root 运行（workspace 挂载卷归 node）
USER node
WORKDIR /app

EXPOSE 18082
CMD ["node", "agent.mjs"]
