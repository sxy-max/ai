# 云端部署 + 矩阵验证工作流（V1.4 沉淀，可复用）

目标：go-ai 本地验证 → 云端部署 → 真实矩阵的完整流程。每条命令都是踩坑后的最终形态。

## 1. 前置条件

- 本地：`npm run typecheck && npm run test:core && npm run test:e2e` 全绿
- 服务器：`ssh tencent-ai`（ubuntu@122.51.78.4），docker 需 `sudo`（ubuntu 无 docker 组权限）
- 服务器容器 env 固定于 `/opt/ai-client/.env`——**改 env 必须 rm+run，restart 不生效**

## 2. 构建 + 传输 + 部署（约 10 分钟）

```bash
cd /d/Projects/go-ai
docker build -t ai-client:v1.4 .          # 失败常见原因见 §5
docker save ai-client:v1.4 -o /tmp/ai-client-v1.4.tar
scp /tmp/ai-client-v1.4.tar tencent-ai:/tmp/
ssh tencent-ai "sudo docker load -i /tmp/ai-client-v1.4.tar"
# 替换容器（web + worker 顺序无要求；保留网络/卷/端口）
ssh tencent-ai "sudo docker rm -f ai-client ai-task-worker
  sudo docker run -d --name ai-client --network go-ai-net --restart unless-stopped \
    -v /opt/ai-client/data:/data -p 127.0.0.1:3000:3000 \
    --env-file /opt/ai-client/.env ai-client:v1.4
  sudo docker run -d --name ai-task-worker --network go-ai-net --restart unless-stopped \
    -v /opt/ai-client/data:/data --env-file /opt/ai-client/.env \
    ai-client:v1.4 node scripts/task-worker.cjs"
# 迁移（schema 无变更时输出 "already applied"）
ssh tencent-ai "sudo docker run --rm --network go-ai-net --env-file /opt/ai-client/.env \
  -v /opt/ai-client/data:/data ai-client:v1.4 node scripts/db-migrate.cjs"
```

## 3. 云端真实矩阵（10-15 分钟，真实模型）

```bash
scp scripts/cloud-v14.mjs tencent-ai:/tmp/
ssh tencent-ai "sudo mkdir -p /tmp/v14-fixtures && sudo chmod 777 /tmp/v14-fixtures
  sudo docker run --rm --network go-ai-net --env-file /opt/ai-client/.env -u root \
    -v /tmp/cloud-v14.mjs:/v14.mjs -v /tmp/v14-fixtures:/fixtures \
    ai-client:v1.4 node /v14.mjs 2>&1 | tail -30"
```

脚本要点（勿回退）：
- 固定账号登录优先（注册限流 5/h 同 IP）
- **jszip 不可用**：容器 standalone 无 jszip 包（被打进 bundle）→ PPTX 验证用 busybox `unzip -l/-p`；上传用例用多文件而非 zip
- `-u root`：fixtures 挂载目录属主 root，node 用户写不了
- 产物必须下载后校验真实格式（%PDF- / PK / 内容包含）

## 4. 回滚

```bash
ssh tencent-ai "sudo docker rm -f ai-client ai-task-worker
  sudo docker run -d --name ai-client ... ai-client:v1.3   # 镜像 1b1b8a31eda3
  sudo docker run -d --name ai-task-worker ... ai-client:v1.3 node scripts/task-worker.cjs"
# 源码备份：/opt/ai-client-backup-v11
```

## 5. 已知坑（每条都实际踩过）

| 坑 | 修复 |
|---|---|
| worker esbuild 打包失败：`No loader for .node`（@napi-rs/canvas） | Dockerfile esbuild `--external:@napi-rs/canvas`（pdf 管线引入） |
| Windows 构建的 standalone 含 win32 canvas 二进制 → Linux 服务器挂 | 无——镜像在 Linux 容器内 npm ci，平台二进制自动正确 |
| 规则规划器缺 PDF 分支 → PDF 任务落 general → "无法生成 PDF" 拒绝回答 | planFromRules 加 4b PDF 分支（artifact 步骤） |
| artifact 类型任务被 LLM 规划拆成 dev 步骤（file-agent 无 pdf 管线）→ 失败 | generatePlan：artifact 类型跳过 LLM 规划，确定性规则 |
| PPT 任务要求两页产出 5 页 | KIND_INSTRUCTIONS.pptx 写死 "5-8 页"→ extractPageCount + trimSlidesTo 截断 |
| xlsx 意图任务无 xlsx 产物（agent 出 csv/markdown） | toolsFor 按 xlsx/csv 意图授权 spreadsheet.* 工具（AgentScope 通道生效；Claude Code 通道工具集在容器侧，记录 limitation） |
| general 步骤报"未配置回答模型"（有 OPENCODE_GO_API_KEY） | completeChat 已支持 opencode-go；若仍失败=模型响应超时（deepseek-v4-pro 思考贪心），fallback 文案误导，记录 limitation |
| 浏览器工具云端不可用 | 服务器无 chromium（playwright external）；本地已全验证；云端记录 limitation |

## 6. 服务器环境事实

- 容器：ai-client(web) + ai-task-worker + go-ai-file-agent + go-ai-agent-runtime + sandbox-daemon(dind) + vision-gateway + cc-auth-gateway + goai-redis + goai-postgres
- 网络：go-ai-net（所有容器）；web 127.0.0.1:3000（nginx 反代公网）
- 磁盘：40G 总量，剩 ~9G；镜像 ai-client:v1.2/1.3/1.4 保留（回滚）
- 模型：opencode-go 通道（OPENCODE_GO_API_KEY）+ exa 搜索（EXA_MCP_URL 公开端点）

---

## V1.6 部署补充（2026-08-16，Claude Code 主 Harness 架构）

### 新增/变更容器
- `ai-client:v1.6`（web + worker，含 Preflight 决策层）
- `go-ai-file-agent:claude`（services/file-agent/Dockerfile：Claude Code CLI 2.1.228 + MCP 工具箱 vision/browser/office/search）
- 已停删：`go-ai-agent-runtime`、`sandbox-daemon`（AgentScope 栈退出生产）
- `/opt/ai-client/.env` 新增：`CLAUDE_CHAT_ENABLED=1`

### file-agent 部署命令（VISION_GATEWAY_TOKEN 从 /opt/vision-gateway/.token 读）
```bash
sudo docker run -d --name go-ai-file-agent --network go-ai-net --restart unless-stopped \
  -v /opt/ai-client/data/workspaces:/data/workspaces \
  -e AGENT_PORT=18082 -e AGENT_MODEL=deepseek-v4-flash \
  -e CC_GATEWAY_URL=http://cc-auth-gateway:18081 \
  -e VISION_GATEWAY_URL=http://vision-gateway:19090 \
  -e VISION_GATEWAY_TOKEN=<来自 /opt/vision-gateway/.token> \
  go-ai-file-agent:claude
```

### 踩坑（勿回退）
- claude 模型名必须经 `--model` 传（ANTHROPIC_MODEL env 不生效 → 默认模型请求网关失败 → 挂起 15min）
- claude 版本固定 2.1.228（latest 行为漂移）
- MCP 工具必须显式授权：`--allowedTools mcp__<name>__*`
- office-mcp 的 generateDocx 返回 GeneratorOutput 对象，写入须取 `.content`
- 容器 CMD/USER/EXPOSE 行易在编辑时误删；构建后 `docker image inspect --format '{{.Config.Cmd}}'` 验证
- 服务器磁盘：镜像 2.8GB，部署前清理旧镜像/tar（保留回滚链 v1.5 + file-agent:latest）

### 回滚（v1.6 → v1.5）
```bash
sudo docker rm -f ai-client ai-task-worker go-ai-file-agent
sudo docker run -d --name ai-client ... ai-client:v1.5
sudo docker run -d --name ai-task-worker ... ai-client:v1.5 node scripts/task-worker.cjs
sudo docker run -d --name go-ai-file-agent ... go-ai-file-agent:latest   # 旧容器（Claude Code + opencode 网关）
# env 去掉 CLAUDE_CHAT_ENABLED（或保留——旧容器无 /chat 端点时 chat 回退 503 → 需删）
# 源码备份：/opt/ai-client-backup-v11
```
