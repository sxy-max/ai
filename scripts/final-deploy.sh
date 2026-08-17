#!/bin/bash
# 最终部署（v2.2 = HEAD 49122ed+，含全部收敛代码；env 清理 AgentScope 残留）
# 用法（本地）：bash scripts/final-deploy.sh
# 前提：本地 docker build 可用；ssh tencent-ai 免密
set -eu
cd "$(dirname "$0")/.."
TAG=ai-client:v2.2
FATAG=go-ai-file-agent:claude-v20

echo "== 1/6 构建 $TAG（含 worker 代码）=="
docker build -t $TAG . 2>&1 | tail -2
echo "== 2/6 构建 file-agent（无代码变更时复用 claude-v20）=="
docker images go-ai-file-agent:claude-v20 --format "{{.ID}}" | grep -q . || docker build -f services/file-agent/Dockerfile -t $FATAG .

echo "== 3/6 验证镜像 =="
docker run --rm $TAG sh -c 'test -f server.js && test -f scripts/task-worker.cjs && grep -c "signal: input.signal" scripts/task-worker.cjs && echo WORKER-OK'
docker run --rm --entrypoint sh $FATAG -c 'grep -c "client disconnected" agent.mjs && echo FA-OK'

echo "== 4/6 传输 + 加载 =="
docker save $TAG -o /tmp/ai-client-v2.2.tar
scp /tmp/ai-client-v2.2.tar tencent-ai:/tmp/
ssh tencent-ai "sudo docker load -i /tmp/ai-client-v2.2.tar | tail -1 && sudo rm -f /tmp/ai-client-v2.2.tar"

echo "== 5/6 替换容器（web+worker；file-agent 不变）=="
ssh tencent-ai '
set -e
cp /opt/ai-client/.env /opt/ai-client/.env.bak-v21 2>/dev/null || sudo cp /opt/ai-client/.env /opt/ai-client/.env.bak-v21
sudo sed -i "/^AGENTSCOPE_URL=/d;/^AGENTSCOPE_MODEL=/d;/^AGENTSCOPE_BASE_URL=/d" /opt/ai-client/.env
sudo docker rm -f ai-client ai-task-worker >/dev/null 2>&1
sudo docker run -d --name ai-client --network go-ai-net --restart unless-stopped \
  -v /opt/ai-client/data:/data -p 127.0.0.1:3000:3000 \
  --env-file /opt/ai-client/.env ai-client:v2.2 >/dev/null
sudo docker run -d --name ai-task-worker --network go-ai-net --restart unless-stopped \
  -v /opt/ai-client/data:/data --env-file /opt/ai-client/.env \
  ai-client:v2.2 node scripts/task-worker.cjs >/dev/null
sleep 10
sudo docker ps --format "{{.Names}} {{.Image}} {{.Status}}" | grep -E "ai-client|ai-task-worker|go-ai-file-agent"
echo "--- health ---"
curl -s http://127.0.0.1:3000/api/health 2>/dev/null | head -c 120; echo
curl -s http://go-ai-file-agent:18082/health 2>/dev/null | head -c 120; echo'

echo "== 6/6 迁移（幂等）=="
ssh tencent-ai "sudo docker run --rm --network go-ai-net --env-file /opt/ai-client/.env -v /opt/ai-client/data:/data ai-client:v2.2 node scripts/db-migrate.cjs 2>&1 | tail -1"
echo "== DEPLOY DONE =="
