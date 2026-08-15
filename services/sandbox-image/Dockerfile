# Go AI Sandbox Runtime Image（V1.3 WP26）
# 沙盒基础镜像：Node + Python + git + shell 工具 + 常用文件/Office 依赖。
# Sandbox 启动即用，不在任务执行中 npm install。
# 用法：docker build -t go-ai-sandbox:v1 services/sandbox-image

FROM node:24-alpine

# 系统工具（文件/归档/网络诊断/运行时）
RUN apk add --no-cache \
    python3 py3-pip \
    git curl ca-certificates \
    zip unzip tar \
    bash jq coreutils \
    openssl

# 常用 Node 全局工具（沙盒内文件处理）
RUN npm install -g --silent jszip-cli 2>/dev/null || true

# 非 root 运行
USER node
WORKDIR /workspace

CMD ["sleep", "infinity"]
