# OpenCode Go Light Client v7 — 最小生产镜像
# 多阶段: deps(npm ci) -> build(next build standalone) -> runner(node:24-alpine)

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
# 任务 Worker 编译进 standalone（全内联自包含：standalone trace 不含 ioredis/docx 等）
# playwright/@napi-rs/canvas 仅运行时可选（VISION_VERIFY 截图 / PDF 渲染；服务器无浏览器 chromium），bundle 时 external
RUN npx esbuild scripts/task-worker.ts --bundle --platform=node --format=cjs \
    --external:playwright --external:@playwright/test --external:playwright-core --external:chromium-bidi \
    --external:@napi-rs/canvas \
    --outfile=.next/standalone/scripts/task-worker.cjs
# 数据库迁移同样编译（服务器无 node，迁移在容器内执行）
RUN npx esbuild scripts/db-migrate.ts --bundle --platform=node --format=cjs \
    --outfile=.next/standalone/scripts/db-migrate.cjs
# migrate 运行时读 schema.sql（相对 __dirname），随产物复制
RUN cp lib/db/schema.sql .next/standalone/scripts/schema.sql

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
EXPOSE 3000
USER node
CMD ["node", "server.js"]
