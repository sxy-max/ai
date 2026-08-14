# OpenCode Go Light Client v7 — Claude Best

面向朋友分享的轻量 AI 网页客户端：OpenCode Go 与可选 Anthropic Claude 共用一个界面，但凭据、模型发现和请求路由完全隔离。

## 已实现

- OpenCode Go：动态模型列表与 `chat/completions`、`messages`、`responses` 三种协议路由
- Anthropic：配置 Key 后动态读取官方 `/v1/models`，Claude 直连官方 `/v1/messages`
- 没有 Anthropic Key 时自动隐藏 Claude，不影响 Go 模型
- 默认推荐 Go 最佳模型；Anthropic 可用时加入当前稳定 Sonnet 推荐
- 多轮流式聊天、reasoning 摘要、图片、文本/PDF、URL 读取和 Exa 搜索
- 服务端保存 API Key；浏览器使用短期 HttpOnly 会话 Cookie
- 模型访问令牌、请求体/附件边界、生产环境密码 fail-closed、基础限流与安全响应头
- 模型供应商局部故障隔离：一方失败时，另一方仍可使用

## 快速开始

要求 Node.js `>=20.16.0`；推荐 Node 22 或 24 LTS，Node 20.16+ 是兼容下限。
当前发布锁定 Next.js `16.3.0`、React / ReactDOM `19.2.8`。

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

打开 `http://localhost:3000`。

最小配置（只用 OpenCode Go）：

```env
OPENCODE_GO_API_KEY=你的_OpenCode_Go_Key
OPENCODE_GO_BASE_URL=https://opencode.ai/zen/go/v1
ACCESS_PASSWORD=至少12位的访问密码
```

同时启用 Claude：

```env
ANTHROPIC_API_KEY=你的_Anthropic_API_Key
ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
```

不要使用 `NEXT_PUBLIC_` 保存任何 Key。

## 任务系统（Cloud Agent Workspace）

任务系统让用户描述目标 + 上传文件后，由后台 Worker 持续执行并产出文件（Excel / PPT / 文档 / 网页等），关闭页面不中断。

### 本地运行

```powershell
# 1. 起 PostgreSQL 与 Redis（任务状态源 + 事件广播）
docker run -d --name goai-pg -e POSTGRES_USER=goai -e POSTGRES_PASSWORD=goai `
  -e POSTGRES_DB=go_ai -p 5432:5432 postgres:16-alpine
docker run -d --name goai-redis -p 16379:6379 redis:7-alpine   # 6379 在 Windows 保留段内，用 16379

# 2. 迁移建表（幂等）
npm run db:migrate

# 3. 起后台 Worker（独立进程，轮询领取任务）
npx tsx scripts/task-worker.ts

# 4. 起 Web（另开终端）
npm run dev
```

页面：`/`（发起任务，可传文件）、`/tasks`（任务列表）、`/tasks/:id`（实时活动 / 步骤 / 产物）、`/workbench`（AgentScope 沙盒工作台）、`/login`。

可选：`DEEPSEEK_API_KEY` 配置后任务规划与回答走 LLM；未配置时任务用确定性规则规划 + 生成器产出文件（闭环仍成立）。

### 任务 API

```text
POST /api/tasks                创建任务（JSON 或 multipart：goal + files[]）
GET  /api/tasks                我的任务列表（含产物/步骤计数）
GET  /api/tasks/:id            详情（steps + artifacts + events）
PATCH /api/tasks/:id           { action: pause | resume | cancel | retry }
GET  /api/tasks/:id/events     SSE 事件流（cursor 续传，页面断开不丢事件）
GET  /api/artifacts/:id        产物下载（归属校验）
```

### 全栈部署（Docker Compose）

```bash
cd deploy/agentscope
cp .env ../../.env   # 或自行 export REDIS_PASSWORD / ACCESS_PASSWORD 等
docker compose up -d --build
```

Compose 编排：postgres + redis + web（Next.js standalone）+ task-worker + sandbox-daemon + agent-runtime（AgentScope 2.0）。Web 与 Worker 共享 `/data` volume（产物/工作区），任务状态在 PostgreSQL，事件经 Redis 广播。

## 模型展示

默认 `ALLOW_OTHER_MODELS=false`，后端只给浏览器签发推荐模型的访问令牌。要打开高级模型抽屉：

```env
ALLOW_OTHER_MODELS=true
```

覆盖全部推荐顺序时，Claude ID 使用 `anthropic/` 前缀：

```env
FEATURED_MODELS=gpt-5.6-luna,anthropic/claude-sonnet-5,grok-4.5,kimi-k3,glm-5.2
```

仅覆盖 Claude 推荐：

```env
ANTHROPIC_FEATURED_MODELS=claude-sonnet-5,claude-opus-5
```

所有 Claude 请求发出前都会移除内部 `anthropic/` 前缀；Anthropic Key 不会发送给 OpenCode Go，Go Key 也不会发送给 Anthropic。

## 验证

```powershell
npm run typecheck
npm test
npm audit --omit=dev
```

`npm test` 会依次运行核心单元测试、生产构建和完整集成测试。

完整的 Vercel 配置、上线检查和故障定位见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 边界

- 普通文本 PDF 在浏览器提取文字；扫描 PDF 仍需 OCR。
- Route Handler 请求需低于 Vercel 请求体限制；客户端会在约 3.3 MB 前主动阻止发送。
- 内置限流只是单个函数实例的保护。公开部署仍应配置 Vercel Firewall，以及 OpenCode Go、Anthropic、Exa 的预算/额度告警。
- 这是共享密码体验版，不是多用户账号、计费或审计系统。
