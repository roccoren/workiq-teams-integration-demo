# Teams integration

The demo exposes a Bot Framework endpoint (`POST /api/messages`) that answers with the same Work IQ engine as the web UI. There are two ways to run it: the **bot** (chat in Teams) and the **app package** (manifest you can sideload).

## 1. Register the bot (Azure)

1. [portal.azure.com](https://portal.azure.com) → **Azure Bot** → **Create**
2. Choose **Multi Tenant** for the app type (or Single Tenant for an internal-only demo)
3. After creation, open **Configuration** and copy the **Microsoft App ID**; create a **client secret** and copy it
4. Set them in the demo's environment:

   ```bash
   MICROSOFT_APP_ID=<app-id>
   MICROSOFT_APP_PASSWORD=<client-secret>
   ```

## 2. Expose the endpoint

The bot must be reachable from the Bot Service (HTTPS). For a demo the simplest path is ngrok:

```bash
ngrok http 3000
# -> https://abc123.ngrok-free.app
```

Then in Azure Bot → **Configuration** → **Messaging endpoint**: `https://abc123.ngrok-free.app/api/messages`.

## 3. Run the demo with the bot

```bash
MICROSOFT_APP_ID=... MICROSOFT_APP_PASSWORD=... npm start
# logs: [teams-bot] enabled — POST /api/messages
```

Test with the Bot Framework Emulator (endpoint `http://localhost:3000/api/messages`, paste the app id/password), then add the bot to Teams.

## 4. Sideload the app package

```bash
node scripts/generate-icons.mjs && node scripts/generate-manifest.mjs
node scripts/pack-teams-app.mjs        # -> teams/workiq-demo.zip（不依赖系统 zip 命令）
```

Upload `workiq-demo.zip` in Teams **Apps → Manage your apps → Upload an app** (or via Teams admin center if sideloading is restricted). The manifest is generated from `TEAMS_APP_ID`, `TEAMS_BOT_ID` and `TEAMS_APP_NAME` env vars.

## 5. 每个用户用自己的权限（per-user delegation）

> **首选做法是 [Teams SSO + OBO](SSO-OBO.md)**：bot 和 tab 拿 Teams SSO 令牌，服务端 On-Behalf-Of
> 换成 `WorkIQAgent.Ask` 的委托令牌，直接调 Work IQ 的 hosted MCP 端点 —— 不装 CLI、不在服务器上
> 登录、不存 refresh token。设置 `OAUTH_CONNECTION_NAME` 后 bot 自动走这条路。
> 本节描述的多账号 CLI 方案是没有 SSO 时的替代方案。

Work IQ CLI 支持**多账号**（`--account <email>`，每个账号独立缓存 token）。demo 按账号维护
独立的 MCP server 进程池，因此可以做到：**每个 Teams 用户用自己的委托身份查询，只看到自己的数据**。

```
Teams 用户 A ──> bot ──> workiq mcp --account A@contoso.com ──> A 的 token ──> 只看到 A 的数据
Teams 用户 B ──> bot ──> workiq mcp --account B@contoso.com ──> B 的 token ──> 只看到 B 的数据
```

### 启用步骤

1. 在 bot 主机上，为每个试点用户完成一次登录（各自用自己的账号授权，约 2 分钟/人）：
   ```bash
   npx -y @microsoft/workiq auth login --account alice@contoso.com
   npx -y @microsoft/workiq auth login --account bob@contoso.com
   ```
2. 配置账号列表（第一个为默认账号）：
   ```bash
   WORKIQ_ACCOUNTS=alice@contoso.com,bob@contoso.com
   ```
3. 配置 Teams 用户 → 账号映射（键可以是 Teams 用户 id、aadObjectId、显示名或邮箱）：
   ```json
   // account-map.json
   { "alice@contoso.com": "alice@contoso.com", "<aadObjectId>": "bob@contoso.com" }
   ```
   ```bash
   ACCOUNT_MAP_FILE=account-map.json
   ```
4. 重启 demo。bot 中可输入 `/whoami` 查看当前解析到的账号。

### 说明与安全

- 每个账号的 refresh token **缓存并长期有效**，且都在这台 bot 主机上 —— 主机必须妥善保护（最小权限账号、仅内网、密钥管理）。这也是"一个机器上的多账号"模式的固有边界。
- 未映射的 Teams 用户会收到提示，不会静默使用默认账号。
- 每个账号的 Work IQ conversation 相互独立；`/reset` 只重置当前用户的会话。
- 若需要"完全无共享缓存"的方案（bot 服务端拿用户 token 直调 Work IQ），目前微软尚未公开第三方直连 A2A 的授权路径 —— 上述多账号模式是当前官方能力内的可行方案。

## 6. What the bot does

- **`/ask <question>`** or just **@mention + question** → queries Work IQ, replies with the answer, then a **Sources** card with an *Open in M365* button per citation (first 6), plus suggested follow-ups.
- **`/reset`** — starts a fresh Work IQ conversation (clears the stored `conversationId`).
- **`/open`** (alias **`/app`**) — posts an Adaptive Card with two buttons: *Open the Workspace tab* (deep link to the personal tab) and *Open in a dialog* (task module). Requires `PUBLIC_URL`; see §8.
- **Multi-turn** — follow-up questions continue the same Work IQ conversation automatically.
- **Welcome** — explains usage when added to a chat.

## 7. Manifest notes

- `manifestVersion` 1.16, bot scopes `personal`, `team`, `groupChat` with command lists for `/ask`, `/open`, `/reset`, `/help`.
- `staticTabs` (entityId `workiq-workspace`, scope `personal`) is emitted **only when `PUBLIC_URL` is set** — otherwise the generator prints a warning and produces a bot-only package.
- `validDomains` includes `localhost`, `*.ngrok-free.app`, `*.ngrok.io`, `*.azurewebsites.net`, `*.azurecontainerapps.io` plus the `PUBLIC_URL` hostname — add yours if you host elsewhere.
- Icons are generated abstract art (color 192×192, outline 32×32) — swap in your own PNGs if you prefer.
- **Schema violations surface as `Manifest parsing error message unavailable`** on upload — Teams gives no
  detail. Any property outside the v1.16 schema is enough: this package originally carried `bots[0].isTeamScoped`,
  which is not part of the schema, and every upload failed with that message. `tests/manifest.test.ts` now validates
  the generator output against the vendored schema (`tests/fixtures/teams-manifest-v1.16.schema.json`), so the same
  class of bug fails `npm test` instead of Teams.
- **`The app's external ID is already being used`** 说明租户目录里已经有同一个 manifest `id` 的应用。两条出路：
  - **更新已有应用**（保留已安装用户、保留 id）：`version` 必须比目录里的高，然后在 Teams 管理中心 →
    Teams 应用 → 管理应用 → 找到该应用 → 上传新版本（个人侧是 应用 → 管理你的应用 → 该应用 → 更新）。
    生成：`TEAMS_APP_VERSION=1.1.0 TEAMS_APP_ID=<原 id> … node scripts/generate-manifest.mjs`
  - **作为新应用上传**：换一个 `TEAMS_APP_ID`（新 GUID）。Entra 应用、bot、Application ID URI 都不用改，
    只是目录里多一条记录；记得把服务端的 `TEAMS_APP_ID` 同步成新 id，否则 `/open` 的 tab 深链会指向旧应用。
- `TEAMS_APP_VERSION`（默认 `1.0.0`）控制 manifest 的 `version`；每次要覆盖已上架的同 id 应用都必须递增。
- `developer.websiteUrl` / `privacyUrl` / `termsOfUseUrl` follow `PUBLIC_URL` when it is set; the server serves
  `/privacy` and `/terms` so those links are not dead.

## 8. 在 Teams 里嵌入 Web UI（Tab / 对话框）

本 demo 的 Web UI 可以直接跑在 Teams 里，和 bot 共用同一个引擎。入口只有一个环境变量：

```bash
PUBLIC_URL=https://workiq-demo.example.azurecontainerapps.io   # 对外可访问的 HTTPS 根地址，不带结尾斜杠
```

`PUBLIC_URL` 同时驱动三处：manifest 里的 `staticTabs.contentUrl`、`validDomains`，以及 bot `/open`
卡片里的对话框地址。**没配置时**：manifest 只含 bot（生成脚本会打印警告），`/open` 会提示"未配置
`PUBLIC_URL`"，不会崩，也不会给出对话框按钮。

### 三种嵌入方式

| 方式 | 怎么进入 | 清单/代码 | 适用场景 |
| --- | --- | --- | --- |
| ① 个人 Tab（static tab） | 左侧应用栏点开应用 | manifest `staticTabs`，`scopes: ["personal"]`，`contentUrl = ${PUBLIC_URL}/?inTeams=1` | 常驻工作区，全高展示 |
| ② 对话框（task module / dialog） | bot 里发 `/open`，点卡片上的 *Open in a dialog* | `Action.Submit` + `data.msteams = { type: "task/fetch" }`，服务端 `onInvokeActivity` 返回 `task.type = "continue"`，URL 为 `${PUBLIC_URL}/?inTeams=1&dialog=1` | 聊天上下文里"就地"查一下，用完关掉 |
| ③ Tab 深链接 | bot 卡片上的 *Open the Workspace tab*，或任何地方贴这个链接 | `https://teams.microsoft.com/l/entity/<TEAMS_APP_ID>/workiq-workspace` | 从对话跳转到常驻 Tab |

`workiq-workspace` 是 `entityId`，manifest（`scripts/generate-manifest.mjs`）和 bot 代码
（`src/api/teams-bot.ts` 的 `TAB_ENTITY_ID`）必须一致，否则深链接打不开。

这里的 Tab 是 **personal scope**（个人应用），不是频道 Tab：不需要 `configurableTabs`，也不需要配置页。

### 硬性要求（缺一不可）

1. **HTTPS + 受信任证书**。Teams 只加载 `https://`，自签名证书会被拒。本地开发用 ngrok /
   localhost.run / dev tunnel 拿一个公网 HTTPS 域名。
2. **域名写进 `validDomains`**。`PUBLIC_URL` 的主机名必须在 manifest 的 `validDomains` 里，
   否则 Teams 直接拒绝渲染（生成脚本已自动加入并去重）。
3. **允许被 Teams iframe 套住**。服务端必须返回：

   ```
   Content-Security-Policy: frame-ancestors 'self' teams.microsoft.com *.teams.microsoft.com
     *.skype.com *.teams.microsoft.us local.teams.office.com *.office.com *.microsoft365.com
     *.cloud.microsoft outlook.office.com outlook.office365.com;
   ```

   并且**绝对不能**发 `X-Frame-Options: DENY` / `SAMEORIGIN`（该响应头优先级高于 CSP，会直接白屏）。
   本项目在 `src/api/routes.ts` 里对所有非 `/api/` 路径设置了上面的 CSP；Express 默认不发
   `X-Frame-Options`，也没有引入 helmet，所以不需要额外关掉什么。
4. **调用 Teams JS SDK**。页面必须 `app.initialize()`，并在初始化完成后 `app.notifySuccess()`，
   否则 Teams 会认为加载失败并显示错误页。本项目把 `@microsoft/teams-js` **打进 bundle**
   （不是 CDN），只在检测到自己被嵌入时（URL 带 `inTeams=1` 或 `window.parent !== window`）
   才动态加载并初始化；初始化失败会 `console.warn` 一次并继续当普通网页跑。
   同时会读取 `app.getContext()` 拿到 host 和主题（`default` / `dark` / `contrast`），
   注册 `app.registerOnThemeChangeHandler` 跟随 Teams 主题切换，并给 `<body>` 加
   `in-teams` / `in-dialog` class 收掉与 Teams 自带 chrome 重复的部分。

### 不能嵌入的情况（很重要）

**任意第三方网站是塞不进 Teams 的。** 只要对方返回 `X-Frame-Options: DENY|SAMEORIGIN`，或者
CSP 的 `frame-ancestors` 不包含 Teams 域名，浏览器就会拒绝渲染，Teams 里只会看到空白或
"拒绝连接"。这是浏览器级别的限制，Teams 侧无法绕过，也不存在"关掉校验"的开关。

所以可嵌入的只有两类站点：

- **你自己能改响应头的站点**（比如本 demo）；
- **官方明确支持 Teams 嵌入的站点**（自己已经把 Teams 域名放进 `frame-ancestors`）。

像 `microsoft365.com` / `office.com` 上的部分页面之外的大多数外部 SaaS，都需要对方提供官方
Teams 应用，或者你自己做一层可控的前端来代理/包装。

### 验证

```bash
# 1. 生成带 Tab 的 manifest
PUBLIC_URL=https://<your-host> TEAMS_APP_ID=... TEAMS_BOT_ID=... node scripts/generate-manifest.mjs

# 2. 确认响应头
curl -sD - -o /dev/null https://<your-host>/ | grep -i -e content-security-policy -e x-frame-options
#   应当只看到 Content-Security-Policy: frame-ancestors ...；没有 X-Frame-Options

# 3. 重新打包并侧载（见 §4），然后在 Teams 里打开应用，或在 bot 里发 /open
```

---

## 9. 部署记录模板

把每个租户的实际值记在一处，排错和交接都省事：

- **目标租户**：`<tenant-id>`（订阅 `<subscription-id>`）
- **App Registration**：`<bot-app-id>`（SingleTenant 还是 MultiTenant）
- **Bot 资源**：`<app-name>-bot`（资源组 `<app-name>-rg`）· Teams 频道已启用
- **Messaging endpoint**：`https://<host>/api/messages`
- **凭据**：`MICROSOFT_APP_ID` + `MICROSOFT_APP_PASSWORD`（`.env.bot.<别名>`，权限 600，不进 git）
- **应用包**：`teams/<app-name>.zip`（manifest id `<teams-app-id>`，`webApplicationInfo.resource` = `api://<host>/botid-<bot-app-id>`）
- **Teams SSO**：Application ID URI 与 manifest 中的 `resource` 必须逐字一致

一键生成上述全部资源见 [DEPLOY-NEW-TENANT.md](DEPLOY-NEW-TENANT.md)；脚本结束时会把这些值写进
`.deploy-state.<别名>.json`（无机密），可直接抄进这张表。

### 关于临时隧道

早期用 localhost.run / ngrok 暴露 `localhost:3000` 时，URL 会随进程重启而变，必须同步更新 bot 的
messaging endpoint、manifest 的 `validDomains` 和 Application ID URI —— 三处任何一处不同步都会静默失败。
部署到 Azure Container Apps 后域名固定，这类问题消失，因此隧道只建议用于本机联调。