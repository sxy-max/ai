#!/usr/bin/env bash
# 本地验证 file-agent MCP bundle 构建链（模拟容器 /app 布局：lib + mcp 同级）。
# 用法: bash scripts/verify-file-agent-bundle.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$(mktemp -d)/app"
mkdir -p "$APP"

cp -r "$ROOT/lib" "$APP/lib"
cp -r "$ROOT/services/file-agent/mcp" "$APP/mcp"

cd "$APP"
echo "== office-mcp =="
echo 'import "./mcp/office-mcp.mjs"' | npx --prefix "$ROOT" esbuild --bundle --platform=node --format=esm \
  --outfile=mcp/office-mcp.bundle.mjs \
  --external:playwright-core --external:xlsx --external:docx --external:pptxgenjs \
  --external:jszip --external:pdfjs-dist --external:@napi-rs/canvas
echo "== browser-mcp =="
echo 'import "./mcp/browser-mcp.mjs"' | npx --prefix "$ROOT" esbuild --bundle --platform=node --format=esm \
  --outfile=mcp/browser-mcp.bundle.mjs --external:playwright-core
echo "== search-mcp =="
echo 'import "./mcp/search-mcp.mjs"' | npx --prefix "$ROOT" esbuild --bundle --platform=node --format=esm \
  --outfile=mcp/search-mcp.bundle.mjs --external:playwright-core

ls -la "$APP/mcp/"*.bundle.mjs
echo "BUNDLE OK"
