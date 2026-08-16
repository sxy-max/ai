<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- 架构唯一真相（本 Goal 定稿）：先读仓库根 CURRENT_EXECUTION_ARCHITECTURE.md。
     当前设计：Claude Code 是唯一主 Harness（go-ai-file-agent 容器）；Preflight（lib/preflight/）
     编译 Execution Directive（WHAT+CONSTRAINT+CAPABILITY）；AgentScope 为 legacy（FORCE_AGENTSCOPE 才进）；
     旧文档（V1.5 及更早的架构/决策）一律视为 HISTORICAL/SUPERSEDED。 -->
