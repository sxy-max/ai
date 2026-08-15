# V13 Sandbox Security Matrix（2026-08-15，V1.3 WP36）

Production Sandbox（DockerSandboxProvider：non-root node、--network none、--read-only + tmpfs、
--memory/--cpus/--pids-limit、cap-drop ALL、no-new-privileges、仅挂载 task workspace）。

## 实测矩阵（本地真实容器验证，tests/sandbox/sandbox-manager.test.ts）

| 攻击面 | 探测 | 结果 |
|--------|------|------|
| 宿主 .env | `test -f /opt/ai-client/.env` | ✅ NOT-FOUND（未挂载） |
| docker.sock | `test -S /var/run/docker.sock` | ✅ NOT-FOUND（未挂载） |
| 其他 task workspace | `test -d /data/workspaces/tasks` | ✅ NOT-FOUND（仅任务 workspace bind） |
| 宿主编排目录 | `/opt/ai-client`、`/data/workspaces` | ✅ NOT-FOUND |
| 任务 workspace 可用 | `ls /workspace/working` | ✅ WS-OK（input/working/output 已挂载） |
| /etc/passwd | `cat /etc/passwd` | ✅ 可读但为容器内文件（非宿主） |
| 路径逃逸（编排侧） | workspace write `../../escape` | ✅ PATH_ESCAPE 拒绝 |
| 超限文件 | 60MB 写入 | ✅ file_too_large 拒绝 |
| 命令超时 | 60s sleep + 2s timeout | ✅ timedOut 终止 |
| CPU/内存/pids | --cpus/--memory/--pids-limit | ✅ 容器创建参数生效 |
| fork bomb | --pids-limit 128 | ✅ pids 限制 |

## 其余防护（代码层）

- ZIP slip / bomb / symlink escape：safeExtractZip + workspace/safety（V1.1 已测）
- 其他用户 workspace / artifact 越权：PG 归属校验（V1.1 已测）
- AgentScope workspace API 读逃逸：404 拒绝（V1.2 已测）
- AgentScope directories 端点宿主枚举：upstream 缺口（V1.2 记录；Docker 沙盒下仅容器内可见）

## WP34/35 失败注入与崩溃一致性

- 任务级崩溃恢复（V1.1 recoverOrphanedTasks）+ Job 级租约接管（V1.3 WP12 循环认领）已测
  （tests/tasks/job-state.test.ts）：kill worker 模拟 → 任务重新入队 + job recovering + 新 worker 认领
- Cancel 中断执行（V1.3 WP19）：per-task abort → agent/sandbox 立即终止 → cancelled（非 failed）
- 关键点 crash（tool 前/后、artifact 后、validation 中、completed 前）：步骤 checkpoint 已持久，
  恢复后已完成步骤跳过、running 步骤回滚——不从头重跑（V1.1/WP11 覆盖）
