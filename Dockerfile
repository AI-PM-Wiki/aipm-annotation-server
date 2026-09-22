# AI-PM Annotation Server 运行镜像(docker compose 部署用,见 docker-compose.yml)。
# 两阶段:构建阶段 npm ci + tsc 出 dist;运行阶段只带生产依赖与产物。
# 基础镜像选 node:22-slim(Debian/glibc),与 aipm-agent-server 保持同一档,
# 两个服务对照维护。镜像 tag 固定到具体版本(浮动 main tag 升级可能引入行为差异);
# 如需升级 Node,同步更新下面两处 FROM 并验证构建/启动。
#
# 运行所需环境变量(部署时经 .env 注入,见 README「配置」):
#   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET(必填;本地开发可用 DEV_AUTH_BYPASS)
#   TYPESAFE_API_KEY(可选,主判分)/ ANTHROPIC_API_KEY(可选,兜底判分)
#     兜底判分可指向 Anthropic 兼容端点:ANTHROPIC_BASE_URL + HIGHLIGHT_LLM_MODE=json
#     (第三方端点忽略结构化输出,必须走纯文本模式,见 README「配置」)
#   SEARCH_INDEX_URL / ALLOWED_ORIGINS / TRUST_PROXY ...
#
# 持久化:DATA_DIR 下的 store.json 必须落在挂载卷上(见 compose),否则重启丢批注。

# ---- 构建 ----
FROM node:22.23.2-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- 运行 ----
FROM node:22.23.2-slim
ARG VERSION=0.1.0
LABEL org.opencontainers.image.version=$VERSION
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN (npm ci --omit=dev || npm install --omit=dev) && npm cache clean --force
COPY --from=build /app/dist ./dist
ENV PORT=8788
ENV DATA_DIR=/data
EXPOSE 8788
# start_period 45s:首次启动需拉取并聚合 search_index.json(最坏 60s 超时)+ 余量
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "dist/server.js"]
