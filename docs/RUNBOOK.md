# 全流程 Runbook：从零到 Teams 里能用

把散在各文档里的步骤按**实际执行顺序**串起来。每一步都标注了「谁来做」「产出什么」「下一步依赖它的什么」。
具体细节分别见 [LIVE-SETUP.md](LIVE-SETUP.md)（Work IQ 租户启用）、[AZURE.md](AZURE.md)（部署）、
[SSO-OBO.md](SSO-OBO.md)（SSO/OBO）、[TEAMS.md](TEAMS.md)（应用包与 Tab/对话框）。

## 前置条件清单（开工前先对一遍）

按"谁负责"分四组。**打 ⚠️ 的是本项目实际踩过、文档里最容易漏的。**

### A. 商业与许可（要花钱的）

| # | 条件 | 验证方式 |
|---|---|---|
| A1 | 每个使用者的 **M365 基础 license**（E3/E5/Business Premium…） | `az rest --method GET --url "https://graph.microsoft.com/v1.0/users/<upn>/licenseDetails"` |
| A2 | 每个使用者的 **Microsoft 365 Copilot license**（或含 Copilot 计划的捆绑，如 `MICROSOFT_365_E7_HUB`）。分配前用户必须有 `usageLocation` | 上条命令输出里要有 `M365_COPILOT_*` 且 `provisioningStatus: Success` |
| A3 | ⚠️ **已激活的 Copilot Credits 用量计费策略，服务里勾了 “Work IQ API”，且使用者已加入策略** | `TOKEN=$(az account get-access-token --resource https://api.powerplatform.com/ --query accessToken -o tsv); curl -H "Authorization: Bearer $TOKEN" "https://api.powerplatform.com/licensing/billingPolicies?api-version=2022-03-01-preview"` → 不能是 `{"value":[]}` |
| A4 | **Azure 订阅**（托管服务；同时用作 A3 的 pay-as-you-go 计费方式） | `az account show` |

### B. 租户管理员一次性操作

需要角色：**Global Admin / Privileged Role Admin / Cloud Application Admin / Application Admin** 之一；上传应用还需 **Teams 管理员**。

| # | 条件 | 验证方式 |
|---|---|---|
| B1 | Work IQ 租户启用：10 个 MCP Server 服务主体 + Work IQ CLI 服务主体 + 7 个 Graph 委托权限 + 各 MCP Server 权限 | `node scripts/enable-workiq-tenant.mjs`（幂等，末尾自检应为 11 条授权） |
| B2 | ⚠️ **Work IQ 这个「被访问的 API」`fdcc1f02-…` 的服务主体**——它就是令牌的 audience（`api://workiq.svc.cloud.microsoft`、`https://workiq.svc.cloud.microsoft/mcp` 等 SPN 都指向它），也是 `WorkIQAgent.Ask` 的发布者。官方 `Enable-WorkIQToolsForTenant.ps1` 只建 CLI 与下游 MCP server，**唯独不建它**（work-iq#172），缺了就 `AADSTS650052` | `az ad sp show --id fdcc1f02-fc51-4226-8753-f668596af7f7 --query servicePrincipalNames` |
| B3 | 你的应用被授予 `WorkIQAgent.Ask`（委托、**Admin 型**） | `scripts/setup-sso.mjs` 第 6 步回读，或查 `oauth2PermissionGrants` |
| B4 | Teams 自定义应用上传策略（sideload）或走管理中心目录上传 | Teams 管理中心 → Teams 应用 → 设置策略 |

### C. 身份与 Bot 资源

| # | 条件 | 说明 |
|---|---|---|
| C1 | Entra **应用注册** + 客户端密码 | `scripts/deploy-teams.mjs` 产出，写入 `.env.bot` |
| C2 | **Azure Bot**（F0 免费）+ 启用 Teams 频道 + messaging endpoint | 同上；endpoint 由 `deploy-azure.mjs` 回写 |
| C3 | ⚠️ **单租户还是多租户**要先决定：SingleTenant bot 只能服务本租户用户，且服务端必须配 `MICROSOFT_APP_TENANT_ID`（SDK 的 `channelAuthTenant`），否则去 `botframework.com` 换 token → `AADSTS700016`，**消息完全无回复** | 自检：用 bot 凭据向 `login.microsoftonline.com/<tenantId>/oauth2/v2.0/token` 换 `https://api.botframework.com/.default` 应成功 |
| C4 | Teams SSO 配置：token v2、Application ID URI `api://<host>/botid-<appId>`、暴露 `access_as_user`、预授权 7 个 Teams/M365/Outlook 客户端 id | `scripts/setup-sso.mjs` |
| C5 | Azure Bot 的 **OAuth 连接**（`Aadv2`，scope=`WorkIQAgent.Ask`，`tokenExchangeUrl`=C4 的 URI）——bot 侧 SSO 用 | 同上，`OAUTH_CONNECTION_NAME` 指向它 |

### D. 运行环境与工程约束

| # | 条件 | 说明 |
|---|---|---|
| D1 | **公网 HTTPS 域名**（`PUBLIC_URL`，有效证书） | Tab/对话框/SSO 的 `resource` 与 `validDomains` 都由它决定 |
| D2 | 服务允许被 Teams iframe：`frame-ancestors` CSP 且**无** `X-Frame-Options` | 本仓库已实现 |
| D3 | Node 20 + az CLI；镜像用 `az acr build` 服务端构建（本机不需要 Docker） | |
| D4 | ⚠️ 走 **CLI/stdio** 路径时：引擎主机必须有桌面会话（`workiq auth login` 依赖 MSAL broker + localhost 回环，无头容器完不成）。走 **SSO+OBO** 则完全不需要 CLI | |
| D5 | 订阅治理策略可能禁用存储账号共享密钥/公网访问 → Container Apps 挂 Azure Files 会失败，用 `PERSIST_HOME=0` | 见 [AZURE.md](AZURE.md) §2.1 |

### 按目标分级（不必一次全齐）

| 目标 | 需要 |
|---|---|
| **演示链路**（mock 数据，Teams 里能聊、能开 Tab） | C1 C2 C3 · D1 D2 D3 · B4 |
| **真实数据 + 每用户身份**（推荐形态） | 上面全部 + A1 A2 **A3** · B1 B2 B3 · C4 C5 |
| 真实数据但用 CLI 多账号（无 SSO） | 演示链路 + A1 A2 A3 · B1 B2 · **D4** |

## 0. 三类授权，先分清楚

初次做这套东西最容易混的就是"到底有几种同意"。实际是**三层，互不替代**：

| # | 授权对象 | 谁同意 | 作用 | 不做会怎样 |
|---|---|---|---|---|
| ① | **Work IQ 首方应用**（CLI `ba081686-…` + 各 MCP server 服务主体） | 租户管理员，一次 | 让 Work IQ 后端有权代表用户读 M365（Mail/Chat/Sites/People/ChannelMessage/Transcript/ExternalItem 7 个委托 Graph scope） | Work IQ 在这个租户里根本不可用 |
| ② | **应用要 `WorkIQAgent.Ask`**（资源 `fdcc1f02-…`，委托、**Admin 型**） | 租户管理员，一次 | 让你的服务能用 OBO 换到"代表该用户调用 Work IQ"的令牌 | OBO 换票返回 `AADSTS65001` → 接口 401 `OBO_CONSENT_REQUIRED` |
| ③ | **Teams SSO**：你的应用暴露 `access_as_user` + 预授权 Teams 客户端 id | 开发者配置（预授权后用户无需再点同意） | 让 Teams 直接把用户令牌发给你的 Tab/Bot | Tab 拿不到令牌，只能匿名；Bot 反复弹登录卡 |

另外还有**三件与"权限"无关但必须有**的东西：

- **Microsoft 365 Copilot license**（每个使用者）+ M365 基础 license（E3/E5/Business Premium…）。Work IQ 跑在 Copilot Chat API 上，没 license 拿到令牌也会被拒。
- **覆盖 Work IQ API 的用量计费策略（Copilot Credits）并处于“已激活”状态**。Work IQ 的数据面按 Copilot Credits 计量，
  没有生效的计费策略时，令牌、同意、license 全对也会被拒：`The caller is not entitled to use this tool.` /
  `Status: Forbidden`。配置入口：<https://admin.cloud.microsoft/> → Copilot → **Cost management** → Configuration →
  添加支出策略（服务里必须勾上 **Work IQ API**，绑定 pay-as-you-go 的 Azure 订阅或预付积分，并把使用者加进策略）。
  官方前置条件见 [Enable your tenant for Work IQ](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/enable-work-iq)。
- **Teams 自定义应用上传权限**（个人 sideload 策略或 Teams 管理中心目录上传）。

## 1. 令牌是怎么流动的

```
Teams 客户端
  │  ① Teams SSO
  │     Tab : teams-js authentication.getAuthToken()
  │     Bot : Azure Bot OAuth 连接 + signin/tokenExchange
  │     令牌 aud = api://<host>/botid-<appId>，scp = access_as_user
  ▼
你的服务（Express，Azure Container Apps）
  │  ② On-Behalf-Of（@azure/msal-node）
  │     assertion = 上面的令牌，scope = fdcc1f02-…/WorkIQAgent.Ask
  ▼
Entra ─── ③ 用户委托 access token ───►
  │
  │  ④ Authorization: Bearer <token>
  ▼
https://workiq.svc.cloud.microsoft/mcp   （Work IQ hosted MCP，Streamable HTTP）
  │  tools: ask / retrieve / fetch_blob / search_paths …
  ▼
Work IQ 后端 ── 用①的同意 ── Microsoft 365（只返回该用户有权限的数据）
```

服务端不保存任何 refresh token；没有用户令牌时（浏览器直开、未配 SSO 的 bot）走 `WORKIQ_MODE`
指定的共享引擎（mock 演示或 CLI live）。

## 2. 执行顺序（有依赖，别跳）

### 步骤 1 —— 租户启用 Work IQ（授权①）

```bash
az login --tenant <tenantId>            # Global / Cloud Application / Application Admin
node scripts/enable-workiq-tenant.mjs   # 官方 Enable-WorkIQToolsForTenant.ps1 的 az 版
```

它 provision 10 个 Work IQ MCP Server 服务主体 + Work IQ CLI 服务主体，再以 `AllPrincipals`
授予 7 个 Graph 委托权限和各 MCP Server 的权限（正常结果：11 条授权）。

也可以用浏览器一键同意 `https://login.microsoftonline.com/<tenantId>/adminconsent?client_id=ba081686-…`，
但**点完会跳到打不开的 `http://localhost`** —— Work IQ CLI 是公开客户端，注册的回调就是它，
浏览器打不开既不代表成功也不代表失败。一律以回读授权记录为准，详见 [LIVE-SETUP.md](LIVE-SETUP.md) §1。

**验证**：

```bash
CLI_SP=$(az ad sp show --id ba081686-5d24-4bc6-a0d6-d034ecffed87 --query id -o tsv)
az rest --method GET --url "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?\$filter=clientId eq '$CLI_SP'" \
  --query "value[].scope" -o json     # 应该列出那 7 个 Graph scope，不能是 []
```

### 步骤 2 —— 应用注册 + Azure Bot

```bash
TARGET_TENANT_ID=<tenantId> AZ_SUBSCRIPTION=<subId> \
BOT_APP_TYPE=SingleTenant BOT_RESOURCE_GROUP=<rg> BOT_NAME=workiq-query-bot \
node scripts/deploy-teams.mjs
```

产出：App Registration（client id + secret，写进 `.env.bot`）、Azure Bot（F0）、Teams 频道。
**产出被后面用到**：`MICROSOFT_APP_ID` / `MICROSOFT_APP_PASSWORD`。

> 单租户（SingleTenant）只服务本租户用户；要跨租户就选 MultiTenant，并在每个使用方租户重做授权②。

### 步骤 3 —— 部署服务，拿到公网域名

```bash
MICROSOFT_APP_ID=… MICROSOFT_APP_PASSWORD=… MICROSOFT_APP_TENANT_ID=<tenantId> \
RESOURCE_GROUP=<rg> LOCATION=westus2 APP_NAME=workiq-demo \
WORKIQ_MODE=mock PERSIST_HOME=0 OAUTH_CONNECTION_NAME=workiq \
node scripts/deploy-azure.mjs
```

产出：ACR + Log Analytics + Container Apps 环境 + Container App，以及
**`PUBLIC_URL = https://<app>.<env>.<region>.azurecontainerapps.io`**，脚本同时把 bot 的
messaging endpoint 回写成 `<PUBLIC_URL>/api/messages`。

`PUBLIC_URL` 是后面两步的输入：Application ID URI、manifest 的 tab/SSO 地址都由它决定。
（`PERSIST_HOME=0` 是因为部分订阅策略禁用存储账号共享密钥，见 [AZURE.md](AZURE.md) §2.1。）

### 步骤 4 —— SSO + OBO 配置（授权②③）

```bash
APP_ID=<appId> APP_SECRET=<secret> PUBLIC_URL=https://<host> TENANT_ID=<tenantId> \
CONSENT=1 BOT_NAME=workiq-query-bot BOT_RESOURCE_GROUP=<rg> \
node scripts/setup-sso.mjs
```

一次做完：provision Work IQ 服务主体 → `requestedAccessTokenVersion=2` → Application ID URI
`api://<host>/botid-<appId>` → 暴露 `access_as_user` → 预授权 Teams/M365/Outlook 客户端 →
申请并**授予** `WorkIQAgent.Ask`（写 `oauth2PermissionGrants`，`AllPrincipals`）→ 建 Azure Bot 的
OAuth 连接（`Aadv2`，scope=`WorkIQAgent.Ask`，`tokenExchangeUrl`=Application ID URI）。

不想用脚本时的手工路径与验证命令见 [SSO-OBO.md](SSO-OBO.md) §2。

### 步骤 5 —— 制作 Teams 应用包

```bash
node scripts/generate-icons.mjs                    # color.png 192×192 + outline.png 32×32
PUBLIC_URL=https://<host> \
TEAMS_APP_ID=<manifest 用的 GUID> TEAMS_BOT_ID=<appId> TEAMS_APP_VERSION=1.0.0 \
node scripts/generate-manifest.mjs
node scripts/pack-teams-app.mjs        # -> teams/workiq-demo.zip（Node zlib 直接写 zip，不依赖系统 zip）
```

生成的 `manifest.json`（v1.16）包含四块，缺一块就少一种能力：

| 块 | 作用 |
|---|---|
| `bots[]` | 聊天入口，命令 `/ask` `/open` `/reset` `/help`（`/signout`、`/whoami` 亦可用） |
| `staticTabs[]` | 个人 Tab，`contentUrl = <PUBLIC_URL>/?inTeams=1` |
| `webApplicationInfo` | **Teams SSO**：`id` = 应用注册 client id，`resource` = Application ID URI（必须与步骤 4 写进 Entra 的完全一致） |
| `validDomains` | 允许在 Teams 里被框住的域名（脚本自动带上 `PUBLIC_URL` 的主机名） |

上传：Teams → 应用 → 管理你的应用 → 上传自定义应用；或 Teams 管理中心 → Teams 应用 → 管理应用。

三个必须知道的坑（都踩过）：

- 任何 schema 之外的属性 → 上传报 **`Manifest parsing error message unavailable`**（无细节）。
  仓库里 `tests/manifest.test.ts` 会拿官方 v1.16 schema 校验生成结果，把这类问题挡在本地。
- 同一个 `id` 再上传 → **`The app's external ID is already being used`**。要么递增
  `TEAMS_APP_VERSION` 走"更新"，要么换一个 `TEAMS_APP_ID` 当新应用（记得同步服务端的 `TEAMS_APP_ID`，
  `/open` 的 tab 深链用它）。
- 服务端必须允许被 Teams iframe：返回 `Content-Security-Policy: frame-ancestors … teams.microsoft.com …`
  且**不能**有 `X-Frame-Options`；页面要调 teams-js 的 `app.initialize()` + `notifySuccess()`。这些仓库里已实现。

### 步骤 6 —— 验证

| 检查 | 命令 / 动作 | 期望 |
|---|---|---|
| 服务活着 | `curl <PUBLIC_URL>/api/health` | `{"ok":true,...}` |
| OBO 已装配 | `curl <PUBLIC_URL>/api/meta` | `sso.configured = true` |
| Tab 拿到令牌 | 在 Teams 里打开 Tab | 右上角出现身份 chip；`sso.enabled = true` |
| Bot 通了 | 在聊天里 `/ask …` | 有回答（`WORKIQ_MODE=mock` 时是示例数据） |
| Work IQ 真数据 | Tab 里提问 | 引用指向你自己的邮件/会议/文档 |
| 不经过 Teams 的探针 | `TENANT_ID=… node scripts/probe-mcp.mjs "…"` | 设备码登录后 `tools/list` + `ask` 成功 |

## 3. 排错索引（按现象）

| 现象 | 根因 | 处理 |
|---|---|---|
| Teams 里能打开窗口，**发消息没有任何回复** | 单租户 bot 没指定颁发者租户，SDK 去 `botframework.com` 换 channel token → `AADSTS700016`，turn 在发消息前就挂了 | 设 `MICROSOFT_APP_TENANT_ID`（代码据此传 `channelAuthTenant`）。自检：用 bot 凭据向 `login.microsoftonline.com/<tenantId>/oauth2/v2.0/token` 换 `https://api.botframework.com/.default`，应成功；向 `…/botframework.com/…` 换则报 700016 |
| 接口 401 `OBO_CONSENT_REQUIRED` | 授权②没做 | `CONSENT=1 node scripts/setup-sso.mjs` 或管理员同意 URL |
| 接口 401 `OBO_UNAUTHORIZED` | 令牌受众/预授权不对 | Application ID URI 必须与 manifest `webApplicationInfo.resource` 逐字一致；Teams 客户端 id 已预授权 |
| MCP 返回 401 → `WORKIQ_UNAUTHORIZED` | 令牌缺 `WorkIQAgent.Ask` | 补授权② |
| 工具返回 `Status: Forbidden` / `The caller is not entitled to use this tool. Please check your billing policy and AI credit entitlement.` | **令牌、同意、license 都对，卡在计费策略**：租户没有覆盖 **Work IQ API** 的已激活支出策略（Copilot Credits）。诊断特征：`search_paths`/`get_schema`/`list_agents` 这类控制面工具能用，`ask`/`fetch`/`fetch_blob`/`call_function` 数据面全部被拒 | admin.cloud.microsoft → Copilot → Cost management → Configuration → 添加并**激活**支出策略（勾 Work IQ API、绑定计费方式、把用户加进去）。查现状：`TOKEN=$(az account get-access-token --resource https://api.powerplatform.com/ --query accessToken -o tsv); curl -H "Authorization: Bearer $TOKEN" "https://api.powerplatform.com/licensing/billingPolicies?api-version=2022-03-01-preview"` —— 返回 `{"value":[]}` 就是没有策略。**坑**：激活弹窗里"每用户月度上限（可选）"开着但没填数字会禁用「激活」按钮，提示文字在折叠区下面，页面上看起来却像已配置好；另一个判据是 Billing & usage → Pay-as-you-go services 里**看不到 Work IQ API**。策略生效可能要数小时到数天 |
| `EULA_REQUIRED` | 该用户没接受 Work IQ EULA | bot 里发 `/eula`（对当前登录身份调一次 `accept_eula`）。注意：计费策略没到位时 `accept_eula` 本身也会报 not entitled |
| 容器里 `workiq auth login` 失败 | CLI 走 MSAL broker（libmsalruntime → libcurl/libX11/webkit2gtk）+ localhost 回环，无头环境完不成 | 别在容器里登录，改用本文的 SSO+OBO；或用 `ENGINE_API_URL` 分离式拓扑 |
| 副本一直 `Activating`，日志 `mount failed: exit status 32` | 订阅策略把存储账号强制成 `allowSharedKeyAccess=false` + `publicNetworkAccess=Disabled` | `PERSIST_HOME=0` 重新部署 |

## 4. 一页纸的最小清单

```
管理员（一次）
  ① Work IQ 租户启用同意（ba081686-…）
  ② 你的应用的 WorkIQAgent.Ask 管理员同意
  ③ 给使用者分配 Microsoft 365 Copilot license
  ④ 允许上传自定义 Teams 应用

开发者
  1. node scripts/deploy-teams.mjs      → appId / secret / Azure Bot
  2. node scripts/deploy-azure.mjs      → PUBLIC_URL（并回写 messaging endpoint）
  3. node scripts/setup-sso.mjs         → Application ID URI / access_as_user / 预授权 / ②/ OAuth 连接
  4. generate-icons + generate-manifest → teams/workiq-demo.zip
  5. 上传应用包 → 在 Teams 里验证 Tab 与 Bot
```
