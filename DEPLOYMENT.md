# OpenCode Go Light Client v7 部署指南

## 1. 部署关系

推荐部署到 Vercel：Next.js 页面、Route Handlers、服务端环境变量和流式响应可以一起托管。

```text
代码 -> GitHub / Vercel
OpenCode Go Key -> 只调用 OpenCode Go
Anthropic Key -> 只调用 Anthropic Claude
朋友 -> 只得到网站链接和 ACCESS_PASSWORD
```

## 2. 准备

必需：

- GitHub 与 Vercel 账号
- OpenCode Go Key 或 Anthropic Key（至少配置一个）
- 一个至少 12 位、建议 16 位以上的共享访问密码

可选：

- Anthropic Key：启用 Claude
- Exa Key：匿名 Hosted MCP 额度不够时使用
- Vercel Firewall / WAF 与各供应商预算告警

## 3. 本地验证

```powershell
cd opencode-go-light-client-v7-claude-best
npm ci
Copy-Item .env.example .env.local
```

编辑 `.env.local`。只用 Go 的最小配置：

```env
OPENCODE_GO_API_KEY=你的_OpenCode_Go_Key
OPENCODE_GO_BASE_URL=https://opencode.ai/zen/go/v1
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
ACCESS_PASSWORD=至少12位的访问密码
EXA_MCP_URL=https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa
EXA_API_KEY=
MAX_OUTPUT_TOKENS=8192
FEATURED_MODELS=gpt-5.6-luna,grok-4.5,kimi-k3,glm-5.2
ALLOW_OTHER_MODELS=false
```

Go + Claude：

```env
OPENCODE_GO_API_KEY=你的_OpenCode_Go_Key
OPENCODE_GO_BASE_URL=https://opencode.ai/zen/go/v1
ANTHROPIC_API_KEY=你的_Anthropic_API_Key
ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
ACCESS_PASSWORD=至少12位的访问密码
EXA_MCP_URL=https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa
EXA_API_KEY=
SYSTEM_PROMPT=
MAX_OUTPUT_TOKENS=8192
FEATURED_MODELS=
ANTHROPIC_FEATURED_MODELS=
ALLOW_OTHER_MODELS=false
RATE_LIMIT_REQUESTS_PER_MINUTE=30
```

空的 `FEATURED_MODELS` 会使用内置 Go 推荐，并在 Anthropic 官方模型列表命中稳定 Sonnet 时自动加入 Claude。若要固定型号，使用官方 `/v1/models` 实际返回的 ID：

```env
FEATURED_MODELS=gpt-5.6-luna,anthropic/claude-sonnet-5,grok-4.5,kimi-k3,glm-5.2
```

启动并验证：

```powershell
npm run typecheck
npm test
npm run dev
```

`npm test` 会依次运行核心单元测试、生产构建和完整集成测试。

打开 `http://localhost:3000`，依次测试密码、模型列表、Go 对话、Claude（若配置）、联网、URL、TXT/PDF 和 JPEG/PNG/WebP。

## 4. 上传 GitHub

`.gitignore` 已忽略所有 `.env*`，只保留 `.env.example`。提交前仍应检查：

```powershell
git status
git diff -- .env.local
```

正常提交：

```powershell
git init
git add .
git commit -m "deploy opencode go light client v7"
```

不要提交 `.env.local`、API Key、访问密码或 `.vercel`。

## 5. Vercel

在 Vercel 选择 `Add New Project -> Import Git Repository`。Framework 使用 Next.js（当前锁定 `16.3.0`）。

- 如果 `package.json` 就在仓库根目录，Root Directory 保持默认。
- 如果项目在子目录，Root Directory 填 `opencode-go-light-client-v7-claude-best`。
- Install Command 使用 `npm ci`。
- Build Command 使用 `npm run build`。
- Node.js 推荐选择 22.x 或 24.x LTS（Vercel 当前默认可用 24.x）；20.16+ 仅作为兼容下限。

**时长上限（重要）**：各 API 路由已显式设置 `maxDuration`——`/api/chat` 300s、`/api/fetch-url` 60s、`/api/models` 30s、`/api/search` 60s。Vercel 会按套餐强制函数时长上限，且隐式默认往往更低：Hobby 固定约 60s，长对话流式回复会被切断；Pro 需要启用 **Fluid Compute** 才支持 300s。请按你的套餐确认上限是否 ≥300s（尤其 chat 路由），否则长回复会在中途被 Vercel 中断。

在 `Settings -> Environment Variables` 添加与 `.env.local` 相同的变量，并确保 Production 环境也勾选。不要创建：

```env
NEXT_PUBLIC_OPENCODE_GO_API_KEY=...
NEXT_PUBLIC_ANTHROPIC_API_KEY=...
```

修改变量后必须重新部署。

## 6. 安全与费用

- 生产环境缺少、仍使用示例值或少于 12 位的 `ACCESS_PASSWORD` 时，服务端会 fail-closed 并返回 503。
- 登录成功后浏览器只保存 HttpOnly 会话 Cookie，不保存共享密码。
- `/api/models` 只为可见模型签发短期访问令牌；`ALLOW_OTHER_MODELS=false` 时不能绕过 UI 直调隐藏模型。
- 内置 `RATE_LIMIT_REQUESTS_PER_MINUTE` 是单个热实例的基础保护，不是全局额度系统。
- 对公开 URL，请在 Vercel Firewall 配置持久 IP/区域/速率策略，并在 OpenCode Go、Anthropic、Exa 设置预算和告警。
- 定期轮换所有 Key；一旦怀疑 `.env` 泄露，先吊销 Key，再清理 Git 历史。

## 7. 上线后检查

```text
1. 页面能打开，错误密码被拒绝
2. 正确密码成功，刷新后会话仍有效
3. 模型列表显示正确供应商
4. Go 模型正常流式返回
5. 有 Anthropic Key 时 Claude 正常流式返回；无 Key 时不显示 Claude
6. Reasoning 摘要、停止按钮和错误提示正常
7. 联网与 URL 读取正常，私网/localhost URL 被拒绝
8. TXT、文本 PDF、JPEG/PNG/WebP 正常；超限文件被前端阻止
9. 手机宽度下模型、参数、消息滚动和输入框正常
10. Vercel 日志不出现密码或 API Key
```

发给朋友的只有：

```text
网站链接
ACCESS_PASSWORD
```

## 8. 常见错误

- `ACCESS_PASSWORD is required...`：Vercel Production 没配置密码，或改完没有重新部署。
- `No model provider is currently available`：Key 无效、Base URL 错误或供应商网络失败。
- Claude 不显示：`ANTHROPIC_API_KEY` 为空/无效，或固定的 `FEATURED_MODELS` 没包含 `anthropic/` ID。
- `Model access token is invalid or expired`：刷新页面以重新读取模型列表。
- `Unknown protocol route`：OpenCode Go 新模型尚未匹配 `lib/opencode.ts`；先不要放进推荐列表。
- 联网失败：匿名 Exa 额度受限时填写 `EXA_API_KEY` 并重新部署。
- 扫描 PDF 无文字：先 OCR；当前客户端只抽取文本层。
- 413/附件过大：减少图片/文件或新建对话。项目主动控制在 Vercel 请求限制以内。

## 9. 发布门槛

每次依赖或路由改动后执行：

```powershell
npm ci
npm run typecheck
npm test
npm audit --omit=dev
```

只有高危/严重漏洞为 0、构建通过，并完成上述上线检查后再分享链接。
