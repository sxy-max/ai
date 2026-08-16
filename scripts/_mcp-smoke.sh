#!/bin/bash
# 容器内 office-mcp 冒烟（initialize + tools/list + office.document）
set -e
cat > /tmp/mcp-in.txt << 'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"office.document","arguments":{"markdown":"# 测试文档\n\n内容","output_path":"/tmp/mcp-test.docx"}}}
EOF
echo "== initialize+list =="
timeout 20 node /app/mcp/office-mcp.bundle.mjs < /tmp/mcp-in.txt 2>&1 | head -3 || echo "EXIT=$?"
echo "== docx 产物 =="
ls -la /tmp/mcp-test.docx 2>/dev/null || echo "无 docx"
