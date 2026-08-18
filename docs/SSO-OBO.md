# Teams SSO + OBO：每个用户用自己的权限查 Work IQ

这条链路把 Teams 用户的身份一路传到 Work IQ：**不需要 Work IQ CLI、不需要在服务器上登录、不存任何 refresh token**，
因此可以直接跑在无头容器（Azure Container Apps）里，并且天然只能看到当前用户有权限的数据。

```
Teams（Tab / Bot）
   │ ① Teams SSO：teams-js authentication.getAuthToken() / Bot OAuth 连接
   │    token: aud = api://<host>/botid-<appId>, scp = access_as_user
   ▼
你的服务（Express）
   │ ② On-Behalf-Of：@azure/msal-node acquireTokenOnBehalfOf
   │    scope = fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask
   ▼
Entra ──③ 用户委托 access token──►
   │
   ▼ ④ Authorization: Bearer <token>
https://workiq.svc.cloud.microsoft/mcp   （Work IQ hosted MCP，Streamable HTTP）
   │ tools: ask · retrieve · fetch_blob · search_paths · …
   ▼
该用户权限范围内的 M365 数据
```

端点信息不是猜的，来自 Work IQ 自己发布的受保护资源元数据：

```bash
curl -s https://workiq.svc.cloud.microsoft/.well-known/oauth-protected-resource/mcp
# {"resource":"https://workiq.svc.cloud.microsoft/mcp",
#  "authorization_servers":["https://login.microsoftonline.com/organizations/v2.0"],
#  "scopes_supported":["fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask"],
#  "resource_name":"Work IQ"}
```

## 1. 一条命令完成 Entra / Bot 配置

```bash
APP_ID=<botAppId> APP_SECRET=<botSecret> \
PUBLIC_URL=https://<你的域名> TENANT_ID=<tenantId> \
CONSENT=1 BOT_NAME=workiq-query-bot BOT_RESOURCE_GROUP=<rg> \
node scripts/setup-sso.mjs
```

脚本做的事（全部幂等，可反复跑）：

| 步骤 | 内容 |
| --- | --- |
| 1 | 在租户里 provision Work IQ 首方服务主体：`fdcc1f02-…`（Work IQ API）与 `ba081686-…`（Work IQ CLI） |
| 2–3 | 给你的 App Registration 写入 `requestedAccessTokenVersion=2`、Application ID URI `api://<host>/botid-<appId>`、暴露 `access_as_user`、预授权 Teams/M365/Outlook 客户端、申请 `WorkIQAgent.Ask` |
| 4 | 确保你的应用在本租户有服务主体（授予同意的前提） |
| 5 | `CONSENT=1` 时直接写 `oauth2PermissionGrants`（`AllPrincipals`，全租户生效）；否则打印同意 URL |
| 6 | 回读授权记录做验证 |
| 7 | 给 Azure Bot 建 OAuth 连接（`--service Aadv2`，scope = `WorkIQAgent.Ask`，`tokenExchangeUrl` = Application ID URI），bot 侧 SSO 用 |

## 2. 如何同意 `WorkIQAgent.Ask`（三选一）

`WorkIQAgent.Ask` 是 **Admin 型委托权限**（`type: Admin`），用户自己点不了，必须管理员同意。
需要的角色：**全局管理员 / 特权角色管理员 / 云应用程序管理员 / 应用程序管理员**。

### 方式 A：脚本（推荐）

```bash
CONSENT=1 APP_ID=<appId> PUBLIC_URL=https://<host> node scripts/setup-sso.mjs
```

它直接写 Graph 的 `oauth2PermissionGrants`。之所以不用 `az ad app permission admin-consent`：
那条命令走旧门户接口，服务主体刚创建时会报
`The <appId> service principal name is already present for the tenant`，写 grant 更可靠。

### 方式 B：浏览器同意 URL

```text
https://login.microsoftonline.com/<tenantId>/adminconsent?client_id=<你的appId>
```

用管理员账号打开 → **接受**。同意的是"你的应用"申请的全部委托权限（其中就包含 `WorkIQAgent.Ask`）。

### 方式 C：Entra 门户点选

**Microsoft Entra 管理中心** → 应用注册 → 选中你的应用 → **API 权限** → **添加权限** →
**我的组织使用的 API** → 搜索 **Work IQ** → 选 **委托的权限** → 勾 `WorkIQAgent.Ask` → 添加 →
再点 **为 \<租户\> 授予管理员同意**。

> 如果 "我的组织使用的 API" 里搜不到 Work IQ，说明服务主体还没 provision，先执行
> `az ad sp create --id fdcc1f02-fc51-4226-8753-f668596af7f7`（或跑 `scripts/setup-sso.mjs` 的第 1 步）。

### 验证同意结果

```bash
CLIENT_SP=$(az ad sp show --id <你的appId> --query id -o tsv)
WORKIQ_SP=$(az ad sp show --id fdcc1f02-fc51-4226-8753-f668596af7f7 --query id -o tsv)
az rest --method GET --url "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?\$filter=clientId eq '$CLIENT_SP'" \
  --query "value[?resourceId=='$WORKIQ_SP'].{scope:scope,consentType:consentType}" -o json
# [ { "scope": "WorkIQAgent.Ask", "consentType": "AllPrincipals" } ]
```

Work IQ 暴露的全部委托权限（本仓库实测读取）：

| scope | id | 类型 |
| --- | --- | --- |
| `WorkIQAgent.Ask` | `0b1715fd-f4bf-4c63-b16d-5be31f9847c2` | Admin |
| `WorkIQAgent.Ask.Selected` | `42f2c7e0-405b-4ba5-97f4-321811533545` | Admin |
| `WorkIQSettings.Read.All` | `f71d8d23-630d-4393-8028-23eb6aff9fa1` | Admin |
| `WorkIQSettings.ReadWrite.All` | `f04d9c17-7655-466c-b294-a41d08b4607c` | Admin |

> 同意 ≠ 有数据。每个用户仍然需要 **Microsoft 365 Copilot license**，租户也要完成 Work IQ 启用
> （见 [LIVE-SETUP.md](LIVE-SETUP.md)），否则调用会返回授权或 license 相关错误。

## 3. 服务端环境变量

| 变量 | 说明 |
| --- | --- |
| `MICROSOFT_APP_ID` / `MICROSOFT_APP_PASSWORD` | 机密客户端凭据，OBO 用（与 bot 共用同一个 App Registration） |
| `MICROSOFT_APP_TENANT_ID` | OBO 的 authority 租户；**必填**，缺了 OBO 不会启用 |
| `AAD_TENANT_ID` / `AAD_CLIENT_ID` / `AAD_CLIENT_SECRET` | 想让 SSO 用另一个应用时覆盖上面三个 |
| `WORKIQ_MCP_URL` | 默认 `https://workiq.svc.cloud.microsoft/mcp` |
| `WORKIQ_SCOPE` | 默认 `fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask` |
| `OAUTH_CONNECTION_NAME` | Azure Bot 的 OAuth 连接名；**只有设置了 bot 才走 SSO**，否则 bot 继续用共享引擎 |
| `PUBLIC_URL` | 决定 manifest 的 `webApplicationInfo.resource` 与 Application ID URI |

启动日志会打印一行 `[obo] armed — <url> …` 或 `[obo] disabled — …`，`GET /api/meta` 里的
`sso.configured` 同样反映这个状态。

## 4. 运行时行为

| 场景 | 走哪条路 |
| --- | --- |
| Tab / Web UI 带 `Authorization: Bearer <Teams SSO token>` | OBO → hosted MCP，**该用户自己的数据** |
| Web UI 匿名访问（浏览器直接打开，非 Teams） | 共享引擎（`WORKIQ_MODE`：mock 演示或 CLI live） |
| Bot 且配置了 `OAUTH_CONNECTION_NAME` | `getUserToken` → 有票直接查；没票发 OAuthCard，Teams 静默 `signin/tokenExchange` |
| Bot 未配置连接 | 旧行为：共享引擎 + `ACCOUNT_MAP_FILE` |

- 每用户引擎按 `oid + token 过期时间` 缓存，令牌轮换时旧引擎会被关闭。
- OBO 失败**绝不回落**到共享引擎（那会用错身份查数据），一律返回 HTTP 401 `{error, code, hint}`。
- Bot 命令：`/signout` 清除 SSO 票据与缓存引擎；`/whoami` 在 SSO 生效时显示令牌里的 UPN。

## 5. 排错

| 现象 | 含义 / 处理 |
| --- | --- |
| `code: OBO_CONSENT_REQUIRED`（AADSTS65001） | `WorkIQAgent.Ask` 还没被管理员同意 —— 见第 2 节 |
| `code: OBO_UNAUTHORIZED`（AADSTS500131/50013/700016/5002710） | 令牌受众或预授权不对：Application ID URI 必须与 manifest 的 `webApplicationInfo.resource` **完全一致**，且 Teams 客户端 id 已预授权 |
| `code: WORKIQ_UNAUTHORIZED`（MCP 端点 401/403） | 换到的 token 缺 `WorkIQAgent.Ask`，或用户没有 Copilot license |
| `code: EULA_REQUIRED` | 该用户还没接受 Work IQ EULA —— hosted MCP 提供 `accept_eula` 工具，可在应用内调用一次 |
| Tab 里看不到身份、请求匿名 | `webApplicationInfo` 没进 manifest（`PUBLIC_URL` + bot id 都要有），或应用包没重新上传 |
| bot 一直弹登录卡 | OAuth 连接的 `tokenExchangeUrl` 与 Application ID URI 不一致，或连接的 scope 没写 `WorkIQAgent.Ask` |

### 不经过 Teams 的探测

```bash
npm run build
TENANT_ID=<tenantId> node scripts/probe-mcp.mjs "What meetings do I have this week?"
```

用设备码登录（默认用 Work IQ CLI 的公开客户端，它允许 device code），拿到委托令牌后用本仓库的
`HttpMcpClient` 跑 `initialize` / `tools/list` / `ask`。这能把"租户是否启用、用户是否有 license、
端点协议是否兼容"与 Teams 侧的问题区分开。

想验证**你自己的** App Registration 能不能拿到 `WorkIQAgent.Ask`，传 `CLIENT_ID=<你的appId>`；
机密客户端默认不允许 device code，需要临时
`az ad app update --id <appId> --set isFallbackPublicClient=true`，验证完改回 `false`
（生产走 OBO，不需要公开客户端）。

## 6. 与旧的 CLI 路径的关系

| | CLI（stdio） | SSO + OBO（hosted MCP） |
| --- | --- | --- |
| 身份 | 服务器上缓存的账号（每人登录一次） | 请求里的用户令牌 |
| 无头容器 | ❌ 登录要浏览器/broker | ✅ |
| 服务器保存 refresh token | 是（安全边界差） | 否 |
| 多副本 | ❌ 状态在实例本地 | ✅ 无实例本地状态 |
| 镜像体积 | +146 MB（CLI 原生二进制） | 不需要 CLI |

两条路径共存：没有用户令牌时仍然使用 `WORKIQ_MODE` 指定的共享引擎（mock 演示或 CLI live），
`ENGINE_API_URL` 分离式拓扑也保持不变。
