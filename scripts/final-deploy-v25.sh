#!/bin/bash
# 最终部署 v2.5（Mobile Workbench + Viewer + Content Standard）
# 用法（本地）：bash scripts/final-deploy-v25.sh
# 前提：本地 docker build 可用；ssh tencent-ai 免密
set -eu
cd "$(dirname "$0")/.."
TAG=ai-client:v2.5
FATAG=go-ai-file-agent:claude-v20
V2_4_BACKUP=ai-client:v2.4

echo "== 1/6 构建 $TAG（含 worker 代码）=="
docker build -t $TAG . 2>&1 | tail -2
echo "== 2/6 构建 file-agent（无代码变更时复用 claude-v20）=="
docker images go-ai-file-agent:claude-v20 --format "{{.ID}}" | grep -q . || docker build -f services/file-agent/Dockerfile -t $FATAG .

echo "== 3/6 验证镜像 =="
docker run --rm $TAG sh -c 'test -f server.js && test -f scripts/task-worker.cjs && echo WORKER-OK'
docker run --rm --entrypoint sh $FATAG -c 'grep -c "client disconnected" agent.mjs && echo FA-OK'

echo "== 4/6 传输 + 加载 =="
docker save $TAG -o /tmp/ai-client-v2.5.tar
scp /tmp/ai-client-v2.5.tar tencent-ai:/tmp/
ssh tencent-ai "sudo docker load -i /tmp/ai-client-v2.5.tar | tail -1 && sudo rm -f /tmp/ai-client-v2.5.tar"

echo "== 5/6 替换容器（web+worker；file-agent 不变）=="
ssh tencent-ai '
set -e
# 回滚点：v2.4 镜像保留为 ai-client:prev（含备份 env .env.bak-v25）
sudo docker tag ai-client:v2.4 ai-client:prev 2>/dev/null || true
cp /opt/ai-client/.env /opt/ai-client/.env.bak-v25 2>/dev/null || sudo cp /opt/ai-client/.env /opt/ai-client/.env.bak-v25
sudo docker rm -f ai-client ai-task-worker >/dev/null 2>&1
sudo docker run -d --name ai-client --network go-ai-net --restart unless-stopped \
  -v /opt/ai-client/data:/data -p 127.0.0.1:3000:3000 \
  --env-file /opt/ai-client/.env ai-client:v2.5 >/dev/null
sudo docker run -d --name ai-task-worker --network go-ai-net --restart unless-stopped \
  -v /opt/ai-client/data:/data --env-file /opt/ai-client/.env \
  ai-client:v2.5 node scripts/task-worker.cjs >/dev/null
sleep 10
sudo docker ps --format "{{.Names}} {{.Image}} {{.Status}}" | grep -E "ai-client|ai-task-worker|go-ai-file-agent"
echo "--- health ---"
curl -s http://127.0.0.1:3000/api/health 2>/dev/null | head -c 120; echo
curl -s http://go-ai-file-agent:18082/health 2>/dev/null | head -c 120; echo'

echo "== 6/6 迁移（幂等）=="
ssh tencent-ai "sudo docker run --rm --network go-ai-net --env-file /opt/ai-client/.env -v /opt/ai-client/data:/data ai-client:v2.5 node scripts/db-migrate.cjs 2>&1 | tail -1"
echo "== DEPLOY DONE =="
