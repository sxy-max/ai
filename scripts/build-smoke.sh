#!/bin/bash
# V1.3 WP25：生产构建 smoke test —— 服务器 docker build 可重复性验证。
# 连续 3 次构建（第 2/3 次走缓存），每次检查 standalone 产物完整：
#   server.js 存在 + scripts/task-worker.cjs + scripts/db-migrate.cjs + scripts/schema.sql
# 用法（服务器）：bash scripts/build-smoke.sh [镜像名:tag]
set -euo pipefail

IMAGE="${1:-ai-client:v1.3}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

check_standalone() {
  local output
  output="$(sudo docker run --rm "$IMAGE" sh -c 'test -f server.js && test -f scripts/task-worker.cjs && test -f scripts/db-migrate.cjs && test -f scripts/schema.sql && echo STANDALONE-OK || echo STANDALONE-MISSING')"
  if [ "$output" != "STANDALONE-OK" ]; then
    echo "FAIL: standalone 产物不完整（$output）"
    return 1
  fi
  echo "  standalone 完整（server.js + worker + migrate + schema）"
}

echo "== build-smoke: $IMAGE =="
for i in 1 2 3; do
  echo "-- build #$i --"
  sudo docker build -t "$IMAGE" "$PROJECT_DIR" > /tmp/build-smoke-$i.log 2>&1
  check_standalone
done
echo "== PASS: 3/3 构建成功且 standalone 完整 =="
