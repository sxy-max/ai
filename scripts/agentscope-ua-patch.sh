#!/bin/sh
# V1.5：AgentScope 容器 UA patch（opencode.ai 按 User-Agent 过滤，SDK 默认 UA 403）。
# 容器重建（docker rm/run）后必须重跑。用法：ssh tencent-ai 'bash -s' < scripts/agentscope-ua-patch.sh
set -e
sudo docker exec -u root go-ai-agent-runtime sh -c '
  P=/usr/local/lib/python3.11/site-packages/agentscope/model/_openai_chat/_model.py
  if ! grep -q "GoAI/1.5" "$P"; then
    cp "$P" /tmp/_model.py.bak
    python - <<PYEOF
p = "/usr/local/lib/python3.11/site-packages/agentscope/model/_openai_chat/_model.py"
s = open(p).read()
old = "self.client_kwargs = client_kwargs or {}"
new = "self.client_kwargs = client_kwargs or {\\\"default_headers\\\": {\\\"User-Agent\\\": \\\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 GoAI/1.5\\\"}}"
assert old in s, "patch anchor missing"
open(p, "w").write(s.replace(old, new))
print("patched")
PYEOF
  else
    echo "already patched"
  fi
'
sudo docker restart go-ai-agent-runtime
echo "restarted"
