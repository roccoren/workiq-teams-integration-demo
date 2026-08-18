# Live mode setup — connect the demo to a real Work IQ tenant

本文覆盖两部分：**租户启用**（第 1 节，两条路径都必需）和 **CLI/stdio 路径的本机登录**（第 2 节起）。

> **先确认你需要哪条路径。** Teams 场景请走 [SSO-OBO.md](SSO-OBO.md)：Teams 令牌经 On-Behalf-Of 换成
> `WorkIQAgent.Ask` 后直接调 Work IQ 的托管 HTTP MCP 端点，**服务器上不需要装 CLI、不需要登录、不存任何
> refresh token**，因此能跑在无头容器里。本文第 2 节之后的 `workiq auth login` 只适用于：在**自己的机器上**
> 跑 Web UI（没有 Teams）、或使用多账号 stdio 拓扑——那时没有 Teams 令牌可换，凭据只能由 CLI 持有。

## 0. Prerequisites

- A Microsoft 365 tenant with **Copilot licenses** for the demo account
- **An *activated* usage-based billing (Copilot Credits) policy that covers the “Work IQ API” service**, with the
  users added to it — Work IQ's data plane is metered, so without it every data call fails with
  `The caller is not entitled to use this tool. Please check your billing policy and AI credit entitlement.`
  even when consent and licenses are correct. Set it up at <https://admin.cloud.microsoft/> → Copilot →
  **Cost management** → Configuration → add spending policy (bind pay-as-you-go Azure subscription or prepaid
  credits). Official prerequisites: [Enable your tenant for Work IQ](https://learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/enable-work-iq).
- A tenant administrator who can grant consent
- Node.js 18+ on the demo machine

## 1. Tenant administrator: enable Work IQ

**Do I need an App Registration?** For the core Work IQ query flow — **no**. Work IQ ships its own
first-party app (client id `ba081686-5d24-4bc6-a0d6-d034ecffed87`); you only grant admin consent for it
and sign in the CLI once on that machine (interactive login — see §2). The only case where *you* create an App Registration is the
optional Teams bot (an Azure Bot registration — see docs/TEAMS.md).


**推荐做法（一条命令，不走浏览器）：**

```bash
az login --tenant <tenantId>            # Global / Cloud Application / Application Admin
node scripts/enable-workiq-tenant.mjs
```

它是官方 `Enable-WorkIQToolsForTenant.ps1` 的 az 版：provision 10 个 Work IQ MCP Server 服务主体
和 Work IQ CLI 服务主体，然后以 `AllPrincipals` 授予 7 个 Graph 委托权限 + 各 MCP Server 的
`Tools.ListInvoke.All` / `McpServers.*.All`，最后回读全部授权做验证（正常是 11 条）。

**其他方式：**

1. 浏览器一键同意（替换 `{your-tenant-id}`）：

   ```text
   https://login.microsoftonline.com/{your-tenant-id}/adminconsent?client_id=ba081686-5d24-4bc6-a0d6-d034ecffed87
   ```

   用管理员账号登录并 **Accept**。
2. Entra 门户：企业应用程序 → **Work IQ CLI** → 安全性 → 权限 → **为组织授予管理员同意**（不涉及任何跳转）。
3. 官方 PowerShell：`Enable-WorkIQToolsForTenant.ps1`（需要 Microsoft.Graph 模块）。

> **点完同意跳到 `http://localhost` 打不开？** 这是正常现象，不是失败：Work IQ CLI 是**公开客户端**，
> 注册的回调地址就是 `http://localhost`（CLI 调试日志里能看到 `"RedirectUri": "http://localhost"`）。
> 只有 CLI 自己在跑时才会有进程监听那个端口来接收回调；用浏览器手动同意时没人监听，于是显示"无法访问"。
> **看地址栏**：带 `admin_consent=True` 说明成功，带 `error=...` 才是失败。
>
> **别用页面判断成败，回读授权记录：**
>
> ```bash
> CLI_SP=$(az ad sp show --id ba081686-5d24-4bc6-a0d6-d034ecffed87 --query id -o tsv)
> az rest --method GET --url "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?\$filter=clientId eq '$CLI_SP'" \
>   --query "value[].{scope:scope,consentType:consentType}" -o json
> ```
>
> 返回 `[]` 就是**没生效**。最常见的原因是同意过程直接失败了（`Access Denied` / `AADSTS650052`——
> 租户里缺 Work IQ MCP Server 服务主体），而错误信息随着那次跳转一起丢在打不开的 localhost 页面里。
> 遇到这种情况直接用上面的脚本，它会先把缺的服务主体建出来再授权。

## 1b. Permissions granted (for the record)

Admin consent for the Work IQ CLI app grants these **Microsoft Graph delegated scopes**
(exact list from the official `Enable-WorkIQToolsForTenant.ps1`):

```text
Sites.Read.All  Mail.Read  People.Read.All  OnlineMeetingTranscript.Read.All
Chat.Read  ChannelMessage.Read.All  ExternalItem.Read.All
```

It also provisions the Work IQ MCP server service principals (Work IQ Tools, Mail, Calendar, Teams,
OneDrive, SharePoint, Word, Admin, Me, M365 Copilot) and consents their permissions. Role required to
run the consent: **Global Admin** (or Cloud Application Admin / Application Admin for the script path).
The demo itself needs **no further Graph permissions** — the CLI's cached delegated tokens are reused.

## 2. On the demo machine: authenticate the CLI once

```bash
# accept the EULA (required on first use)
npx -y @microsoft/workiq accept-eula

# interactive login — opens a browser / OS broker on THIS machine and caches credentials for later CLI/MCP use
npx -y @microsoft/workiq auth login

# sanity check
npx -y @microsoft/workiq ask -q "What meetings do I have this week?" --json
```

If you need a specific account (e.g. a demo service account), pass `--account you@contoso.com` to each command, or set `WORKIQ_ACCOUNT=you@contoso.com` for the demo.

## 3. Start the demo in live mode

```bash
WORKIQ_MODE=live npm start
```

The server probes the Work IQ MCP server at boot (`tools/list`). The UI badge turns **● LIVE — Work IQ tenant**, and queries hit real M365 data. Each question takes roughly 15–40 s (that's Work IQ's reasoning + retrieval); the UI streams status → answer → citations.

## 4. CLI resolution order

The demo resolves the WorkIQ CLI as follows:

1. `WORKIQ_CLI` env var, e.g. `node /path/to/bin/workiq.js` or `npx -y @microsoft/workiq`
2. `./node_modules/.bin/workiq` (installed with `npm install` — `@microsoft/workiq` is a dependency)
3. `workiq` on `PATH`
4. `npx -y @microsoft/workiq` (downloads on first use, ~114 MB)

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `EULA not accepted` | Run `npx -y @microsoft/workiq accept-eula` |
| `AUTH_REQUIRED` / login prompt | Run `npx -y @microsoft/workiq auth login` **on a machine with a browser/desktop session**; check `--account` if you use multiple accounts |
| `AADSTS650052` on admin consent | Run the official `Enable-WorkIQToolsForTenant.ps1` script (see step 1) |
| Slow first query | Expected: Work IQ reasoning takes ~20 s; subsequent calls reuse the MCP process and are often faster |
| Engine falls back to mock | Check server startup warnings (`/api/meta` → `warnings[]`); fix auth/EULA then restart with `WORKIQ_MODE=live` |
| `fetch_blob` errors | The tool needs a *WorkIQ entity path* (e.g. `/drives/{id}/items/{id}/content`). Discover paths with `search_paths` (`POST /api/search-paths`, filter `mail`/`calendar`/`content`) |

## 6. Multi-account mode（每个用户各自的权限）

如果多个用户共用一台服务器（例如 Teams bot 场景），用 Work IQ CLI 的多账号能力：

```bash
# 每个用户在自己的账号下登录一次（交互式登录，token 按账号缓存）
npx -y @microsoft/workiq auth login --account alice@contoso.com
npx -y @microsoft/workiq auth login --account bob@contoso.com

# demo 配置
WORKIQ_ACCOUNTS=alice@contoso.com,bob@contoso.com     # 第一个为默认账号
ACCOUNT_MAP_FILE=account-map.json                     # Teams 用户 -> 账号映射
```

查询时 demo 会为每个账号 spawn 独立的 `workiq mcp --account <email>` 进程，
每个用户的查询只使用该用户自己的委托权限。详见 docs/TEAMS.md 第 5 节。

### 6.1 自服务登录（用户自己完成授权，管理员零操作）

demo 内置**自服务注册页**（Web UI 右上角 🔑 按钮）：用户输入自己的邮箱 → 服务器代跑 `workiq auth login --account <email>` → CLI 输出回显到页面 → 完成后自动把该账号加入账号列表并写入 `ACCOUNT_MAP_FILE`（邮箱 → 邮箱映射）。

- ⚠️ **前提：宿主机能完成交互式登录**。`workiq auth login` 没有 device-code 选项（`workiq auth login --help`），Linux 上它加载 MSAL broker（`libmsalruntime.so`，依赖 libcurl/libX11/webkit2gtk），并使用 `RedirectUri=http://localhost` 的回环重定向 —— 也就是说**必须在同一台机器上弹出浏览器**。在无头容器（Azure Container Apps / App Service）里跑不通，实测报错见 [AZURE.md](AZURE.md) 第 4 节。
- 因此自服务注册只适用于：有桌面会话的引擎主机（开发机 / VDI / 带 X 会话的 VM），配合 `ENGINE_API_URL` 分离式拓扑。
- 可选加固：设置 `ENROLL_TOKEN` 后，`POST /api/enroll` 需要 `x-enroll-token` 头或 `token` 字段（Web UI 通过 `?token=` 传递）。

## 7. Security notes for demos

- The demo API has **no authentication** — bind it to localhost or a VPN for demos, never expose it to the internet.
- Use the **least-privileged account** you can: the demo queries whatever the signed-in Work IQ identity can see (permission-aware by design).
- The Teams bot needs an Azure Bot registration; see [TEAMS.md](TEAMS.md).