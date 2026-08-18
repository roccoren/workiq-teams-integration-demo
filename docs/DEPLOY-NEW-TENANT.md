# 部署到另一个租户

这套东西**没有跨租户共享的运行时状态**——所有租户相关的信息（应用注册、bot、域名、同意、license、计费策略）
都在目标租户里，代码和镜像是通用的。所以"换租户"= 换一份参数 + 重跑一遍脚本链。

## 1. 什么要打包，什么必须重新生成

| 类别 | 内容 | 换租户时 |
|---|---|---|
| **可搬运** | 仓库代码、`Dockerfile`、`infra/main.bicep`、`scripts/*`、图标源、mock 数据 | 原样复用 |
| **可搬运（可选）** | 容器镜像（`az acr import` 从旧租户 ACR 拉过去，省一次构建） | 复用或重建都行 |
| **必须重建** | App Registration + client secret、Azure Bot、Container App 与 `PUBLIC_URL`、Application ID URI、`WorkIQAgent.Ask` 同意、Copilot Credits 计费策略、license 分配、Teams 应用包（因为 manifest 内嵌新域名） | 每个租户一份 |
| **绝不能带走** | `.env.bot*`（client secret）、`account-map.json`、任何 token 缓存 | 每租户单独生成 |

也就是说：**"包"= 仓库快照 + 一份参数文件**，机密不在包里。

### 做一个可交付的仓库快照

```bash
# 干净快照（不含 node_modules / dist / 机密）
git archive --format=tar.gz -o /tmp/workiq-teams-demo.tar.gz HEAD

# 或者带上未提交的改动
tar --exclude-vcs --exclude=node_modules --exclude=dist --exclude='.env*' \
    --exclude='teams/*.zip' -czf /tmp/workiq-teams-demo.tar.gz .
```

对方解压后只需要 Node 20 + az CLI：

```bash
npm ci && npm run build
```

### 复用镜像（可选，省 1.5 分钟构建）

```bash
az acr import --name <新租户ACR> --source <旧ACR>.azurecr.io/workiq-demo:v20260817091634 \
  --image workiq-demo:v20260817091634 --username <旧ACR用户名> --password <旧ACR密码>
# 之后用 SKIP_BUILD=1 IMAGE_TAG=v20260817091634 部署
```

镜像里没有任何租户信息——租户相关的全部走环境变量（`MICROSOFT_APP_*`、`PUBLIC_URL`、`OAUTH_CONNECTION_NAME`…）。

## 2. 一条命令完成

```bash
cp .env.tenant.example .env.contoso
# 编辑 .env.contoso：TARGET_TENANT_ID / AZ_SUBSCRIPTION / APP_NAME 三个必填

az login --tenant <目标租户id>          # 需要 Global(或 Cloud App/App) Admin + 订阅 Contributor

# 预检：Node/az/curl、当前租户、订阅、参数、billingPolicies；绝不改资源
npm run deploy:tenant -- .env.contoso --dry-run

# 在 admin.cloud.microsoft 配好并“激活” Work IQ API 计费策略后：
echo 'BILLING_POLICY_READY=1' >> .env.contoso
npm run deploy:tenant -- .env.contoso
```

`BILLING_POLICY_READY=1` 是**人工确认开关**，不是脚本绕过：计费策略绑定真实按量 Azure 费用，脚本
不会擅自创建。未设置时会在创建任何资源前退出；只想预部署 mock/Teams/SSO 链路可显式传
`--allow-billing-pending`，但真实 Work IQ 数据面必定 `not entitled`。

中断后恢复无需重来：`STEPS=4,5 BILLING_POLICY_READY=1 npm run deploy:tenant -- .env.contoso`。
脚本将状态写进 `.deploy-state.<别名>.json`（无机密），凭据单独在 `.env.bot.<别名>`（600，已 gitignore）。

编排顺序（每步幂等，可反复跑；`STEPS=3,4` 只跑其中几步）：

| 步骤 | 脚本 | 产出 |
|---|---|---|
| 0 | — | 校验 `az` 当前登录租户 == 目标租户，切换订阅 |
| 1 | `enable-workiq-tenant.mjs` | 11 个 Work IQ 服务主体 + 委托权限（含官方脚本漏掉的 `fdcc1f02-…`） |
| 2 | `deploy-teams.mjs` | App Registration + secret（写 `.env.bot.<别名>`，600）+ Azure Bot + Teams 频道 |
| 3 | `deploy-azure.mjs` | ACR + Log Analytics + Container Apps + Container App，产出 `PUBLIC_URL`，回写 bot endpoint |
| 4 | `setup-sso.mjs` + 重新部署 | token v2 / Application ID URI / `access_as_user` / 预授权 Teams 客户端 / **`WorkIQAgent.Ask` 管理员同意** / Azure Bot OAuth 连接 |
| 5 | `generate-icons` + `generate-manifest` + `pack-teams-app` | `teams/<APP_NAME>.zip`（含 tab + `webApplicationInfo`） |

打包不再依赖系统 `zip`：`scripts/pack-teams-app.mjs` 用 Node 的 zlib 直接写 zip（三个文件在根目录，DOS 时间戳固定，因此同样输入产出同样字节）。

## 3. 脚本不会替你做的三件事

| 事项 | 为什么必须人工 | 入口 |
|---|---|---|
| ⚠️ **Copilot Credits 计费策略**（勾选 “Work IQ API”、绑定计费方式、加入用户、**激活**） | 绑定真实计费，且没有公开 API | <https://admin.cloud.microsoft/> → Copilot → Cost management → Configuration |
| **Microsoft 365 Copilot license 分配** | 花钱；用户还需要先有 `usageLocation` | M365 管理中心 → 用户 → 许可证 |
| **上传 Teams 应用包** | 需要 Teams 管理员权限（`AppCatalog.ReadWrite.All`） | Teams 管理中心 → Teams 应用 → 管理应用 → 上传 |

没有计费策略时，令牌/同意/license 全对也会得到
`The caller is not entitled to use this tool. Please check your billing policy and AI credit entitlement.`
——判据是"控制面工具能用、数据面全挂"，详见 [RUNBOOK.md](RUNBOOK.md) 排错表。

## 4. 单租户还是多租户

| | SingleTenant | MultiTenant |
|---|---|---|
| App Registration | 每个租户一个 | 一个，被多个租户使用 |
| 服务端配置 | **必须**设 `MICROSOFT_APP_TENANT_ID`（`channelAuthTenant`），否则 `AADSTS700016`、消息无响应 | 不设该变量 |
| 使用方租户要做的事 | 全部步骤在自己租户里做一遍 | 仍需：Work IQ 启用、`WorkIQAgent.Ask` 同意、计费策略、license、上传应用包 |
| 部署 | 每租户一套 Azure 资源 | 可以共用一套服务，但要自己处理跨租户的 OBO authority（`common`/`organizations`）与数据隔离 |

demo/PoC 建议 **SingleTenant，一租户一套**——排错简单，边界清楚。参数文件里 `BOT_APP_TYPE=SingleTenant` 即可。

## 5. 同一台机器上并行管理多个租户

```
.env.contoso        .env.fabrikam        # 参数（可提交，无机密）
.env.bot.contoso    .env.bot.fabrikam    # secret，600，已在 .gitignore
teams/workiq-contoso.zip  teams/workiq-fabrikam.zip
```

`onboard-tenant.mjs` 会用 `TENANT_ALIAS` / `APP_NAME` 给凭据文件和应用包分别命名，互不覆盖。
切租户只需要重新 `az login --tenant <另一个>`，脚本第 0 步会校验当前登录与参数是否一致，不一致直接退出。

## 6. 交付给别人时的检查清单

```
□ 仓库快照（不含 node_modules/dist/.env*）
□ .env.tenant.example + 本文档
□ 目标租户的角色到位：Global/Cloud App/App Admin、Teams 管理员、订阅 Contributor
□ 目标租户已有（或愿意开通）：M365 Copilot license、Copilot Credits 计费策略
□ 说明清楚三件人工事项（第 3 节）与单/多租户选择（第 4 节）
□ 验收命令：curl <PUBLIC_URL>/api/health · curl <PUBLIC_URL>/api/meta（看 sso.configured）
```

## 7. 拆除

```bash
az group delete -n <RESOURCE_GROUP> --yes --no-wait          # 所有 Azure 资源
az ad app delete --id $(grep MICROSOFT_APP_ID .env.bot.<别名> | cut -d= -f2)   # 应用注册（连带 bot 身份）
# Teams 管理中心删除自定义应用；计费策略与 license 按需回收
```
