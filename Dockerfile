# OpenCode Go Light Client v7 — 最小生产镜像
# 多阶段: deps(npm ci) -> build(next build standalone) -> runner(node:24-alpine)

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# 系统 chromium 已装（runner 阶段）；跳过 playwright 浏览器下载（省镜像）
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
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
# V1.4 WP49：系统 chromium——PDF 渲染（pdfGenerator）与 Browser Runtime 的云端路径
# （playwright 浏览器缓存不进镜像；launch 时经 lib/chromium.ts 探测 executablePath）
RUN apk add --no-cache chromium
# @playwright/test 仅被 esbuild 的 task-worker 引用（next build 不 trace）→ 手动拷入 standalone
COPY --from=deps /app/node_modules/playwright ./node_modules/playwright
COPY --from=deps /app/node_modules/playwright-core ./node_modules/playwright-core
COPY --from=deps /app/node_modules/@playwright ./node_modules/@playwright
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
EXPOSE 3000
USER node
CMD ["node", "server.js"]
