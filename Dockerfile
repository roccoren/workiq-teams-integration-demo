# WorkIQ Teams demo —— 生产镜像（多阶段构建）
#
# 默认**不打包** Work IQ CLI：Teams SSO + OBO 走的是托管 HTTP MCP 端点
# （https://workiq.svc.cloud.microsoft/mcp），容器里既不需要 CLI，也不需要登录或 token 缓存。
# 这样镜像少掉 @microsoft/workiq 的 ~146 MB 原生二进制及其 ICU/OpenSSL 运行时依赖。
#
# 只有 CLI/stdio 拓扑（WORKIQ_MODE=live 且不使用 ENGINE_API_URL）才需要它：
#   docker build --build-arg INCLUDE_WORKIQ_CLI=true .
#   az acr build --build-arg INCLUDE_WORKIQ_CLI=true ...        # deploy-azure.mjs 已自动处理
#
# 注意（实测）：即使打进镜像，`workiq auth login` 在无头容器里也完不成——它走 MSAL WAM broker
# （libmsalruntime.so，硬依赖 libwebkit2gtk-4.1/GTK3），最终还要 xdg-open 拉本机浏览器做 loopback
# 重定向。所以容器内的 CLI 只能复用预置的 token 缓存；细节见 docs/AZURE.md 第 4 节。
ARG INCLUDE_WORKIQ_CLI=false

# ---- builder：装依赖 -> tsc + esbuild -> 裁掉 dev（以及可选的 CLI）----
FROM node:20-bookworm-slim AS builder
ARG INCLUDE_WORKIQ_CLI
WORKDIR /app
ENV npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
# tsc -> dist/，esbuild -> public/app.js；构建本身从不 import @microsoft/workiq
RUN npm run build \
 && if [ "$INCLUDE_WORKIQ_CLI" = "true" ]; then npm prune --omit=dev; else npm prune --omit=dev --omit=optional; fi

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
ARG INCLUDE_WORKIQ_CLI
# ca-certificates: 出站 HTTPS（始终需要）
# 其余仅在打包 CLI 时安装：libicu72 + libssl3 是 self-contained .NET 二进制所需，
# libcurl4 + libdbus-1-3 + libsecret-1-0 是 MSAL 缓存/运行时依赖。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && if [ "$INCLUDE_WORKIQ_CLI" = "true" ]; then \
      apt-get install -y --no-install-recommends libicu72 libssl3 libcurl4 libdbus-1-3 libsecret-1-0; \
    fi \
 && rm -rf /var/lib/apt/lists/*
# 固定 uid 1001 + 固定 HOME —— Azure Files 挂载点按这个 uid 授权（见 infra/main.bicep 的 mountOptions），
# workiq 的 MSAL token 缓存与 account-map.json 都落在 $HOME 下，靠挂载卷跨重启保留。
RUN useradd --uid 1001 --create-home --home-dir /home/app --shell /usr/sbin/nologin app
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/home/app
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/public ./public
COPY --chown=app:app package.json ./
COPY --chown=app:app scripts ./scripts
COPY --chown=app:app teams ./teams
USER app
EXPOSE 3000
# express.static("public") 相对 cwd，所以必须在 /app 下启动
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
