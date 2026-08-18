# WorkIQ Teams demo —— 生产镜像（多阶段构建）
#
# live 模式需要 @microsoft/workiq 自带的原生二进制
# node_modules/@microsoft/workiq/bin/linux-x64/workiq（self-contained .NET single-file，
# 整包约 146 MB），它在运行期依赖 ICU 与 OpenSSL —— 因此 runtime 阶段安装
# ca-certificates / libicu72 / libssl3，并把 @microsoft/workiq 保留为生产依赖。
#
# 两种可以“瘦身”的用法（都不需要改这个 Dockerfile）：
#   - WORKIQ_MODE=mock：完全不会 spawn workiq 进程，上面的 ICU/OpenSSL 与 CLI 都用不到；
#   - ENGINE_API_URL=https://engine-host：本容器只做 Web UI + Teams bot 前端，
#     真正的 workiq mcp 进程与每用户 token 缓存留在引擎主机上（见 docs/AZURE.md 分离式拓扑）。
#   如果只跑这两种模式，可以自行删掉 apt 安装那一层并在 runtime 阶段 `npm prune` 掉
#   @microsoft/workiq，镜像可从实测的 ~510 MB 降到 ~200 MB。

# ---- builder：装全量依赖 -> tsc + esbuild -> 裁掉 devDependencies ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
# tsc -> dist/，esbuild -> public/app.js
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
# ca-certificates: 出站 HTTPS
# libicu72 + libssl3: workiq 原生二进制（self-contained .NET）运行所需
# libcurl4 + libdbus-1-3 + libsecret-1-0: MSAL 缓存/运行时依赖，缺了会多出一堆加载告警
#
# 注意（实测）：`workiq auth login` 走的是 MSAL WAM broker（libmsalruntime.so），
# 它硬依赖 libwebkit2gtk-4.1 / GTK3 桌面栈，broker 装上后也只会去调 xdg-open 拉浏览器，
# 用的是 loopback 重定向 —— 无头容器里无论如何都完不成登录（在开发机上同样如此）。
# 所以镜像里不装那 ~250 MB 桌面栈；容器里的 live 模式要么预置 token 缓存到挂载卷，
# 要么走 ENGINE_API_URL 分离式拓扑。细节见 docs/AZURE.md 第 4 节。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates libicu72 libssl3 libcurl4 libdbus-1-3 libsecret-1-0 \
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
