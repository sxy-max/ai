#!/bin/bash
# Cancel 深检查补跑（路径挂载修复版）：/tmp/rec 挂到容器内 /tmp/rec
# 用法：bash /tmp/cancel-deep-rerun.sh 2>&1 | tee /tmp/cancel-deep.log
set -u
LOG=/tmp/cancel-deep.log
cd /tmp
mkdir -p /tmp/rec && sudo chmod 777 /tmp/rec
sudo rm -f /tmp/rec/cancel-phase.json
sudo docker rm -f goai-cancel-runner >/dev/null 2>&1
sudo docker run -d --name goai-cancel-runner --network go-ai-net --env-file /opt/ai-client/.env -u root \
  -v /tmp/cloud-cancel-deep.mjs:/deep.mjs -v /tmp/rec:/tmp/rec ai-client:v2.0 node /deep.mjs >/dev/null
echo "cancel-runner started $(date '+%T')" | tee -a "$LOG"
BEFORE=-1; AFTER=-1
for i in $(seq 1 120); do
  P=$(grep -o '"phase":"[a-z]*"' /tmp/rec/cancel-phase.json 2>/dev/null | head -1)
  case "$P" in
    *running*)
      if [ "$BEFORE" = "-1" ]; then
        BEFORE=$(sudo docker exec go-ai-file-agent sh -c 'pgrep -c claude 2>/dev/null || echo 0')
        echo "cancel 前 file-agent 内 claude 进程数: $BEFORE ($(date '+%T'))" | tee -a "$LOG"
      fi ;;
    *cancelled*)
      if [ "$AFTER" = "-1" ]; then
        sleep 5
        AFTER=$(sudo docker exec go-ai-file-agent sh -c 'pgrep -c claude 2>/dev/null || echo 0')
        echo "cancel 后 file-agent 内 claude 进程数: $AFTER ($(date '+%T'))" | tee -a "$LOG"
      fi ;;
    *settled*) break ;;
    *error*) echo "deep-cancel ERROR: $(cat /tmp/rec/cancel-phase.json)" | tee -a "$LOG"; break ;;
  esac
  sleep 3
done
sudo docker rm -f goai-cancel-runner >/dev/null 2>&1
if [ "$BEFORE" -gt 0 ] && [ "$AFTER" = "0" ]; then
  echo "PASS: 长任务 cancel 后 claude 进程从 $BEFORE → $AFTER（断连 SIGKILL 生效）" | tee -a "$LOG"
elif [ "$BEFORE" = "-1" ] || [ "$AFTER" = "-1" ]; then
  echo "FAIL: 窗口未命中（before=$BEFORE after=$AFTER）" | tee -a "$LOG"
else
  echo "FAIL: before=$BEFORE after=$AFTER（claude 未被 kill）" | tee -a "$LOG"
fi
