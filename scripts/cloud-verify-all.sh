#!/bin/bash
# Cloud AI Work System — 最终验收编排（本 Goal §43/§44）
# 顺序执行（服务器 /tmp 下运行，nohup 后台）：
#   1. Cancel 真终止专项（进程级深检查 + 状态/队列检查）
#   2. 最终矩阵 C01-C12（cloud-final.mjs）
#   3. Harness Benchmark B01-B05 × deepseek-v4-flash / deepseek-v4-pro（每轮切换 AGENT_MODEL）
#   4. 执行恢复验收（kill worker+file-agent → 租约回收 → 续跑完成）
# 用法：bash /tmp/cloud-verify-all.sh 2>&1 | tee /tmp/verify-all.log
set -u
cd /tmp
mkdir -p /tmp/rec
LOG=/tmp/verify-all.log

step() { echo; echo "========== [$1] $(date '+%F %T') ==========" | tee -a "$LOG"; }

# ---------- 1. Cancel 真终止（进程级深检查） ----------
step "C10-Deep: Cancel 进程级深检查"
sudo rm -rf /tmp/rec && mkdir -p /tmp/rec && sudo chmod 777 /tmp/rec
sudo docker rm -f goai-cancel-runner >/dev/null 2>&1
sudo docker run -d --name goai-cancel-runner --network go-ai-net --env-file /opt/ai-client/.env -u root \
  -v /tmp/cloud-cancel-deep.mjs:/deep.mjs -v /tmp/rec:/rec ai-client:v2.0 node /deep.mjs >/dev/null
echo "cancel-runner started"
BEFORE=-1; AFTER=-1
for i in $(seq 1 120); do
  P=$(grep -o '"phase":"[a-z]*"' /tmp/rec/cancel-phase.json 2>/dev/null | head -1)
  case "$P" in
    *running*)
      if [ "$BEFORE" = "-1" ]; then
        BEFORE=$(sudo docker exec go-ai-file-agent sh -c 'pgrep -c claude 2>/dev/null || echo 0')
        echo "cancel 前 file-agent 内 claude 进程数: $BEFORE" | tee -a "$LOG"
      fi
      ;;
    *cancelled*)
      if [ "$AFTER" = "-1" ]; then
        sleep 5
        AFTER=$(sudo docker exec go-ai-file-agent sh -c 'pgrep -c claude 2>/dev/null || echo 0')
        echo "cancel 后 file-agent 内 claude 进程数: $AFTER" | tee -a "$LOG"
      fi
      ;;
    *settled*) break ;;
    *error*) echo "deep-cancel ERROR: $(cat /tmp/rec/cancel-phase.json)" | tee -a "$LOG"; break ;;
  esac
  sleep 3
done
sudo docker rm -f goai-cancel-runner >/dev/null 2>&1
if [ "$BEFORE" -gt 0 ] && [ "$AFTER" = "0" ]; then
  echo "PASS: 长任务 cancel 后 claude 进程从 $BEFORE → $AFTER（断连 SIGKILL 生效）" | tee -a "$LOG"
else
  echo "FAIL/INCONCLUSIVE: before=$BEFORE after=$AFTER（需人工核对，cancel 窗口可能未命中）" | tee -a "$LOG"
fi

# ---------- 1b. Cancel 状态 + 队列不阻塞 ----------
step "C10: Cancel 状态 + 队列不阻塞（cloud-cancel-verify.mjs）"
sudo docker run --rm --network go-ai-net --env-file /opt/ai-client/.env -u root \
  -v /tmp/cloud-cancel-verify.mjs:/cv.mjs ai-client:v2.0 node /cv.mjs 2>&1 | tee -a "$LOG" | tail -4

# ---------- 2. 最终矩阵 C01-C12 ----------
step "C01-C12: 最终矩阵（cloud-final.mjs）"
sudo docker run --rm --network go-ai-net --env-file /opt/ai-client/.env -u root \
  -e CLAUDE_CHAT_ENABLED=1 \
  -v /tmp/cloud-final.mjs:/final.mjs -v /tmp/final-fixtures:/fixtures \
  ai-client:v2.0 node /final.mjs 2>&1 | tee -a "$LOG" | tail -16

# ---------- 3. Harness Benchmark ----------
run_bench() {
  local model="$1"
  step "BENCH model=$model（B01-B05）"
  # 切换 worker 主模型（env 修改必须 rm+run）
  sudo sed -i "s/^AGENT_MODEL=.*/AGENT_MODEL=$model/" /opt/ai-client/.env
  sudo docker rm -f ai-task-worker >/dev/null 2>&1
  sudo docker run -d --name ai-task-worker --network go-ai-net --restart unless-stopped \
    -v /opt/ai-client/data:/data --env-file /opt/ai-client/.env \
    ai-client:v2.0 node scripts/task-worker.cjs >/dev/null
  sleep 8
  sudo docker run --rm --network go-ai-net --env-file /opt/ai-client/.env -u root \
    -e BENCH_MODEL="$model" \
    -v /tmp/cloud-bench.mjs:/bench.mjs -v /tmp/bench-fixtures:/tmp/bench-fixtures \
    ai-client:v2.0 node /bench.mjs 2>&1 | tee -a "$LOG" | tail -12
}
run_bench deepseek-v4-flash
run_bench deepseek-v4-pro
# 恢复默认
sudo sed -i "s/^AGENT_MODEL=.*/AGENT_MODEL=deepseek-v4-flash/" /opt/ai-client/.env
sudo docker rm -f ai-task-worker >/dev/null 2>&1
sudo docker run -d --name ai-task-worker --network go-ai-net --restart unless-stopped \
  -v /opt/ai-client/data:/data --env-file /opt/ai-client/.env \
  ai-client:v2.0 node scripts/task-worker.cjs >/dev/null
sleep 8

# ---------- 4. 执行恢复验收 ----------
step "RECOVERY: worker+file-agent 崩溃 → 租约回收 → 续跑完成"
sudo rm -rf /tmp/rec && mkdir -p /tmp/rec && sudo chmod 777 /tmp/rec
sudo docker rm -f goai-rec-runner >/dev/null 2>&1
sudo docker run -d --name goai-rec-runner --network go-ai-net --env-file /opt/ai-client/.env -u root \
  -v /tmp/cloud-recovery.mjs:/rec.mjs -v /tmp/rec:/rec ai-client:v2.0 node /rec.mjs >/dev/null
echo "rec-runner started" | tee -a "$LOG"
# 等待任务进入执行态（readyForKill）
for i in $(seq 1 80); do
  if grep -q "readyForKill" /tmp/rec/state.json 2>/dev/null; then break; fi
  sleep 3
done
grep -q "readyForKill" /tmp/rec/state.json 2>/dev/null || echo "WARN: 未等到 readyForKill（继续尝试）" | tee -a "$LOG"
sleep 3
echo "killing worker + file-agent at $(date '+%T')" | tee -a "$LOG"
sudo docker rm -f ai-task-worker go-ai-file-agent >/dev/null 2>&1
echo "killed; 等待租约过期与孤儿回收（120s）" | tee -a "$LOG"
sleep 120
echo "restarting worker + file-agent at $(date '+%T')" | tee -a "$LOG"
TOKEN=$(sudo cat /opt/vision-gateway/.token)
sudo docker run -d --name ai-task-worker --network go-ai-net --restart unless-stopped \
  -v /opt/ai-client/data:/data --env-file /opt/ai-client/.env \
  ai-client:v2.0 node scripts/task-worker.cjs >/dev/null
sudo docker run -d --name go-ai-file-agent --network go-ai-net --restart unless-stopped \
  -v /opt/ai-client/data/workspaces:/data/workspaces \
  -e AGENT_MODEL=deepseek-v4-flash \
  -e CC_GATEWAY_URL=http://cc-auth-gateway:18081 \
  -e VISION_GATEWAY_URL=http://vision-gateway:19090 \
  -e VISION_GATEWAY_TOKEN=$TOKEN \
  go-ai-file-agent:claude-v20 >/dev/null
echo "restarted; 等待 rec-runner 完成（最长 30 分钟）" | tee -a "$LOG"
for i in $(seq 1 360); do
  if [ -f /tmp/rec/state.json ] && grep -q '"final"' /tmp/rec/state.json 2>/dev/null; then break; fi
  sleep 5
done
echo "---- rec-runner 最终状态 ----" | tee -a "$LOG"
cat /tmp/rec/state.json 2>/dev/null | tee -a "$LOG"
sudo docker logs goai-rec-runner 2>&1 | tail -5 | tee -a "$LOG"
sudo docker rm -f goai-rec-runner >/dev/null 2>&1
step "ALL DONE $(date '+%F %T')"
