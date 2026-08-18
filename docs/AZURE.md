# 部署到 Azure

把整个 demo（Web UI + Teams bot + Work IQ 引擎）打成一个容器镜像，部署到 **Azure Container Apps**，
镜像在 **ACR 服务端构建**（本机不需要 Docker），token 缓存挂在 **Azure Files** 上跨重启保留。

```
                       ┌──────────── Container Apps 环境 ────────────┐
Teams / 浏览器 ──https──> │ workiq-demo（单副本, 1 vCPU / 2 GiB）        │
                       │  ├─ Express: Web UI + /api/* + /api/messages │
                       │  └─ spawn: workiq mcp (stdio, 按账号一个进程) │
                       │     $HOME=/home/app  ← Azure Files 共享挂载   │
                       └─────────────────────────────────────────────┘
                              ▲ 镜像来自 ACR(Basic, admin)   日志 -> Log Analytics
```

## 0. 前置条件

- **az CLI ≥ 2.60** 并已 `az login`（订阅需要 Contributor 权限）。
- **Azure Bot 已存在**：先跑 `node scripts/deploy-teams.mjs`（见 [TEAMS.md](TEAMS.md)），拿到 `appId` +
  客户端密码（脚本会写进仓库根的 `.env.bot`）。本文档只负责“把服务跑起来”并把 messaging endpoint 回写给它。
- **Work IQ 租户已完成管理员同意**（见 [LIVE-SETUP.md](LIVE-SETUP.md)），否则 live 模式登录会被拒。
- 首次在订阅里用 Container Apps 时需要注册 `Microsoft.App` / `Microsoft.OperationalInsights`，
  脚本会自动 `az provider register`。

## 1. 一条命令部署

```bash
# .env.bot 里就是 deploy-teams.mjs 生成的 appId / secret
MICROSOFT_APP_ID=<botAppId> \
MICROSOFT_APP_PASSWORD=<botSecret> \
ENROLL_TOKEN=$(openssl rand -hex 12) \
node scripts/deploy-azure.mjs
```

脚本步骤（幂等，可反复执行）：

| 步骤 | 动作 |
| --- | --- |
| 0 | 检查 `az` 登录，可选切换订阅 |
| 1 | 注册资源提供程序 |
| 2 | `az group create` |
| 3 | `az deployment group create`（`image=''`）—— 只建基础设施，输出 ACR 名与预测域名 |
| 4 | `az acr build --registry <acr> --image workiq-demo:<tag> .` —— 服务端构建镜像 |
| 5 | 再跑一次同一个 bicep，这次带上真实镜像 —— 创建/更新容器应用 |
| 6 | `az bot update --endpoint https://<fqdn>/api/messages` |
| 7 | 打印下一步（重新生成 Teams 包、Work IQ 账号授权、看日志） |

**为什么分两趟**：第一趟时 ACR 里还没有镜像，容器应用无从拉起；`infra/main.bicep` 里的容器应用带
`if (!empty(image))` 条件，`image` 为空就整个跳过。增量部署不会删除已存在的资源，所以重跑时线上应用不受影响。

**PUBLIC_URL 不需要第三趟回填**：外部 ingress 的 FQDN 恒为 `<应用名>.<环境 defaultDomain>`，
环境建好后 bicep 就能算出来，直接写进容器的 `PUBLIC_URL`（Teams tab / task module 的地址就取自它）。
只有用自定义域名时才需要显式传 `publicUrl` 参数。

常用变体：

```bash
# 先用 mock 模式打通链路（不需要 Work IQ 租户，也不会 spawn CLI）
WORKIQ_MODE=mock node scripts/deploy-azure.mjs

# 只改了 bicep/环境变量，不想重建镜像
SKIP_BUILD=1 node scripts/deploy-azure.mjs

# 部署到别的订阅/区域/名字
AZ_SUBSCRIPTION=<subId> LOCATION=westus3 APP_NAME=workiq-poc node scripts/deploy-azure.mjs
```

部署完成后：

```bash
curl https://<fqdn>/api/health          # {"ok":true,"mode":"live",...}
az containerapp logs show -n workiq-demo -g workiq-demo-rg --follow
```

## 2. 创建了什么，大概多少钱

| 资源 | 规格 | 说明 |
| --- | --- | --- |
| Container Registry | Basic，启用 admin 账号 | demo 简化：用 admin 用户名/密码拉镜像，省掉托管标识 + AcrPull 角色分配 |
| Log Analytics workspace | PerGB2018，保留 30 天 | 容器 stdout/stderr |
| Container Apps 环境 | Consumption | |
| Container App | 1 vCPU / 2 GiB，`minReplicas=maxReplicas=1`，外部 ingress:3000 | |
| 存储账号 + 文件共享 | Standard_LRS，共享 `workiq-home` 16 GiB | 挂在容器的 `/home/app` |

粗略成本（East Asia，按公开定价估算，**以 Azure 定价页为准**）：ACR Basic ≈ $5/月；
容器应用因为 `minReplicas=1` 会一直计费，空闲费率下约 $20–25/月，持续满载约 $75/月；
存储 + 日志通常 < $5/月。**合计 $30–85/月**。不用时 `az group delete -n workiq-demo-rg --yes` 一键清掉。

### 2.0 镜像里带不带 Work IQ CLI

`@microsoft/workiq` 是**可选依赖**（约 146 MB 原生二进制 + ICU/OpenSSL 运行时）。Teams SSO + OBO
走托管 HTTP MCP 端点，容器里根本用不到它，所以默认不打包：

| 变体 | 构建方式 | 实测大小 | 适用 |
| --- | --- | --- | --- |
| 精简（默认） | `--build-arg INCLUDE_WORKIQ_CLI=false` | **313 MB** | Teams SSO + OBO、mock、`ENGINE_API_URL` 分离式 |
| 含 CLI | `--build-arg INCLUDE_WORKIQ_CLI=true` | 512 MB | 容器内自己跑 `workiq mcp`（CLI/stdio 拓扑） |

`scripts/deploy-azure.mjs` 自动判断：显式 `INCLUDE_WORKIQ_CLI=1/0` 优先，否则只有
`WORKIQ_MODE=live` 且没配 `ENGINE_API_URL` 时才带上 CLI。精简镜像里若真去调 live 引擎，
接口会立即返回 `CLI_NOT_FOUND` 并说明三条出路，而不是在请求路径上偷偷 `npx` 下载 146 MB。

### 2.1 订阅策略禁用存储账号共享密钥/公网访问时：`PERSIST_HOME=0`

Container Apps 挂 Azure Files 走的是 **SMB + 存储账号密钥**。如果订阅有治理策略（例如 MCAPS 环境）
把新建存储账号强制改成 `allowSharedKeyAccess=false` + `publicNetworkAccess=Disabled`，挂载会失败，
副本一直卡在 `Activating`，系统日志里是：

```text
MountVolume.SetUp failed for volume "workiq-home" : ... mount failed: exit status 32
Mounting arguments: -t cifs -o dir_mode=0700,file_mode=0600,gid=1001,...
```

`az storage account update --allow-shared-key-access true --public-network-access Enabled` 会被策略
静默回滚（命令成功、属性不变）。这种订阅里直接关掉持久化卷：

```bash
PERSIST_HOME=0 node scripts/deploy-azure.mjs
```

`persistHome=false` 时 bicep 不创建存储账号/文件共享/环境存储，容器也不挂卷。代价：`$HOME` 里的
token 缓存与 `account-map.json` 在重启/换镜像后丢失 —— 对 `WORKIQ_MODE=mock` 无影响，对 live 模式
本来也建议走第 5 节的分离式拓扑。要保留持久化又必须用这类订阅，只能申请策略豁免，或改用
VNet 集成环境 + 存储私有终结点。

## 3. 硬约束：只能一个副本

`infra/main.bicep` 把 `minReplicas` 和 `maxReplicas` 都钉死在 **1**，这不是省钱，是正确性要求：

- `workiq mcp` 是 **stdio 子进程**，demo 按账号维护一个常驻进程池（`src/workiq/pool.ts`），
  进程和会话状态都在实例内存里；
- 每个账号的 **MSAL token 缓存在实例的 `$HOME`** 下。多副本时用户可能在 A 副本完成 device code 登记，
  下一个请求却落到 B 副本 → 提示“未登记”；
- 共享的 Azure Files 是 SMB，多个副本并发写同一份 token 缓存不安全（刷新 token 时会互相覆盖）。

需要横向扩展或高可用，用第 5 节的**分离式拓扑**，别调大 `maxReplicas`。

同理，滚动更新时会短暂出现新旧两个副本；`activeRevisionsMode: 'Single'` 保证旧修订会被替换掉，
但更新瞬间正在进行的查询会中断 —— demo 场景可接受。

> 这条约束只对 **CLI/stdio** 路径成立。用 [Teams SSO + OBO](SSO-OBO.md) 时服务端不再持有任何
> 账号状态（令牌随请求来），可以放开 `maxReplicas`。

## 4. 用户怎么在 Azure 上完成 Work IQ 登录

> **首选路线：不要在容器里登录。** 配好 [Teams SSO + OBO](SSO-OBO.md) 后，用户在 Teams 里的
> 身份直接换成 Work IQ 的委托令牌打到 hosted MCP 端点，容器里既不需要 CLI 也不需要任何缓存。
> 下面三条是**没有** Teams SSO（例如纯 Web、或要用 CLI 专属能力）时的退路。

Work IQ CLI 用的是**委托身份**：每个账号自己登录一次，token 按账号缓存，之后查询只看得到自己的数据。
demo 内置了自助登记接口（`POST /api/enroll` + `GET /api/enroll/:id`，见 `src/api/enroll.ts`），
它在服务端执行 `workiq auth login --account <email>`，并把 CLI 的输出回显到页面上
（注意：CLI **没有** device-code 选项，`workiq auth login --help` 只有 `--account`；它用的是
`RedirectUri=http://localhost` 的回环重定向 + 本机浏览器/broker）。

> ⚠️ **实测结论：`workiq auth login` 在无头容器里跑不通**，这不是本仓库的实现问题。
> Linux 上 CLI 走的是 MSAL WAM broker（`libmsalruntime.so`）：
> - 不装 `libwebkit2gtk-4.1` + GTK3 桌面栈时，直接 `Login failed: Unable to load shared library 'msalruntime'`；
> - 把那 ~250 MB 桌面栈装上后，它接着去调 `xdg-open` 拉本机浏览器、用 loopback 重定向收授权码 ——
>   远端用户的浏览器够不到容器的 `localhost`，同样完不成。
>
> （同一台开发机上直接跑 CLI 也是这个结果，与容器无关。）

因此在 Azure 上，live 模式有三条可行路线：

**路线 1（推荐给正式 demo）：分离式拓扑**——把引擎放在能正常登录的机器上，云上只跑前端/bot。见第 5 节。

**路线 2（未验证，先做小规模试验再依赖它）：把已登录的 token 缓存预置到挂载卷**。在能完成登录的机器
（Windows / macOS / 带桌面的 Linux）上按 [LIVE-SETUP.md](LIVE-SETUP.md) 为每个账号登录一次，然后把该机器上
被登录改动的缓存目录上传到共享 `workiq-home`：

```bash
# 1) 在登录机上找出这次登录写了哪些文件（登录后 5 分钟内执行）
find "$HOME" -maxdepth 3 -newermt '-5 minutes' -type f 2>/dev/null | grep -vi cache/tmp

# 2) 上传到容器的 /home/app（示例：MSAL 扩展缓存目录）
ACC=$(az storage account list -g workiq-demo-rg --query "[0].name" -o tsv)
KEY=$(az storage account keys list -g workiq-demo-rg -n "$ACC" --query "[0].value" -o tsv)
az storage file upload-batch --account-name "$ACC" --account-key "$KEY" \
  --destination workiq-home --source "$HOME/.IdentityService" --destination-path .IdentityService

# 3) 重启容器应用让进程池重新读缓存
az containerapp revision restart -n workiq-demo -g workiq-demo-rg \
  --revision $(az containerapp revision list -n workiq-demo -g workiq-demo-rg --query "[0].name" -o tsv)
```

上传后容器里的 `workiq mcp --account <email>` 直接复用缓存，无需再登录；refresh token 过期前都有效。

> ⚠️ **这条路线本仓库没有端到端验证过，且很可能对部分登录机器无效**：CLI 启用了 MSAL broker，
> 缓存不一定落在 `$HOME`。实测（WSL 开发机）把 `HOME` 换成空目录后，`workiq auth login` 依然
> `Found 1 cached account(s)` 并静默拿到 token —— 说明缓存由 broker（WSL 场景下是 Windows WAM）持有，
> 家目录里根本没有可复制的缓存文件。Windows 上的 WAM 同理（凭据在系统账户管理器里，不是可搬运的文件）。
> 只有当登录机器上第 1 步的 `find` 确实列出了缓存文件时，这条路线才成立；否则请直接走路线 1。

同时把映射写进 `/home/app/account-map.json`（`ACCOUNT_MAP_FILE` 指向它）：

```bash
printf '{"alice@contoso.com":"alice@contoso.com"}' > account-map.json
az storage file upload --account-name "$ACC" --account-key "$KEY" \
  --share-name workiq-home --source account-map.json --path account-map.json
```

这两样东西都在挂载卷上，**重启、换镜像、重新部署都不丢**。

**路线 3：先用 `WORKIQ_MODE=mock` 演示**——链路（Teams tab / bot / 流式回答）完全一致，不需要任何登录。

页面上的自助登记入口保留着：一旦 Work IQ CLI 支持无头 device code（或你在能登录的机器上跑引擎），
它就是可用的。设置了 `ENROLL_TOKEN` 时，登记接口要求 `x-enroll-token` 头或 `token` 字段，
Web UI 通过 `?token=` 传递 —— 把带 token 的链接只发给该用到的人。

> **安全边界（务必向 demo 受众说明）**：所有用户的 **refresh token 都躺在同一个 Azure Files 共享上**，
> 拿到存储账号密钥（或能在容器里执行命令）的人，等于拿到所有已登记用户的委托身份。
> 因此：存储账号别开公网共享密钥外发、限制资源组 RBAC、`ENROLL_TOKEN` 视作密钥管理、
> demo 结束后删掉资源组。共享挂载已通过 `mountOptions` 限制为 `uid=1001` 属主可读写（`0600/0700`），
> 但这只防容器内的其他身份，防不了控制平面权限。生产要做“无共享缓存”，只能等微软开放第三方直连的授权路径
> （见 [TEAMS.md](TEAMS.md) 第 5 节）。

## 5. 备选拓扑 A：分离式（前端上云 + 引擎自持）

不想把所有人的 token 放在云上共享盘，或者需要前端多副本时：

```
Teams / 浏览器 ──> Azure Container Apps（本仓库镜像，ENGINE_API_URL=...）
                      │  不 spawn 任何 workiq 进程，可多副本
                      └──https──> 引擎主机（公司内网/专机，装 CLI + 每用户 token 缓存）
```

部署方式完全一样，只多一个环境变量：

```bash
ENGINE_API_URL=https://engine-host.internal \
MICROSOFT_APP_ID=<botAppId> MICROSOFT_APP_PASSWORD=<secret> \
node scripts/deploy-azure.mjs
```

此时容器里的 `@microsoft/workiq`、ICU/OpenSSL 都用不到（`Dockerfile` 顶部注释说明了怎么裁出一个
~200 MB 的纯前端镜像），Azure Files 挂载也可以不要。引擎主机上按 [LIVE-SETUP.md](LIVE-SETUP.md)
跑 `WORKIQ_MODE=live npm start` 即可。这也是唯一能安全放大 `maxReplicas` 的形态。

## 6. 备选拓扑 B：App Service (Linux 容器)

已经有 App Service 资源池、或者组织不允许用 Container Apps 时：

```bash
az appservice plan create -g workiq-demo-rg -n workiq-plan --is-linux --sku B1
az webapp create -g workiq-demo-rg -p workiq-plan -n workiq-demo \
  --deployment-container-image-name <acr>.azurecr.io/workiq-demo:latest
az webapp config appsettings set -g workiq-demo-rg -n workiq-demo --settings \
  WEBSITES_PORT=3000 WEBSITES_ENABLE_APP_SERVICE_STORAGE=true \
  WORKIQ_MODE=live PUBLIC_URL=https://workiq-demo.azurewebsites.net \
  ACCOUNT_MAP_FILE=/home/app/account-map.json HOME=/home/app
az webapp config set -g workiq-demo-rg -n workiq-demo --always-on true
# 持久化 token 缓存：把 Azure Files 共享挂到 /home/app
az webapp config storage-account add -g workiq-demo-rg -n workiq-demo \
  --custom-id workiqhome --storage-type AzureFiles \
  --account-name <storageAccount> --share-name workiq-home \
  --access-key <key> --mount-path /home/app
```

要点与坑：

- **`ALWAYS_ON`（`--always-on true`）必须开**，否则实例被回收，常驻的 `workiq mcp` 进程池和会话全没；
  Basic (B1) 及以上才支持。
- **`WEBSITES_ENABLE_APP_SERVICE_STORAGE=true`** 才会给 `/home` 持久盘；但 App Service 自带的 `/home`
  是每应用的存储，跨实例共享、性能一般，token 缓存建议仍用上面显式挂载的 Azure Files。
- **同样只能单实例**（`az appservice plan update --number-of-workers 1`），理由同第 3 节。
- App Service 的空闲超时/健康检查配置比 Container Apps 粗糙，Work IQ 查询要 15–40 秒，
  记得把健康检查路径设为 `/api/health` 并放宽超时。

## 7. 自动化不了的三件事

1. **Work IQ 第一方应用的管理员同意** —— 需要目标租户的 Global Admin 点一次
   `https://login.microsoftonline.com/<tenant>/adminconsent?client_id=ba081686-5d24-4bc6-a0d6-d034ecffed87`。
2. **Teams 应用包上架** —— 上传自定义应用需要 Teams 管理员（或开启了 sideload 的用户）在 Teams 管理后台
   操作；`scripts/deploy-teams.mjs UPLOAD=1` 只在你拥有 `AppCatalog.ReadWrite.All` 时才走得通。
3. **每个用户的 Work IQ 登录** —— 必须本人完成，无法由管理员代劳、也无法脚本化（这正是委托身份的意义）；
   而且必须在**有桌面浏览器/GTK 栈的机器**上完成，无头容器里的 `workiq auth login` 一定失败（第 4 节实测）。
   容器只能消费已经登录好的 token 缓存。

## 8. 环境变量与参数速查

### 容器运行时环境变量（`Dockerfile` / `infra/main.bicep` 注入）

| 变量 | 来源 | 说明 |
| --- | --- | --- |
| `NODE_ENV=production` | Dockerfile + bicep | 开启静态资源缓存 |
| `PORT=3000` | Dockerfile + bicep | Express 监听端口，等于 ingress `targetPort` |
| `HOME=/home/app` | Dockerfile + bicep | MSAL token 缓存所在；就是 Azure Files 挂载点 |
| `WORKIQ_MODE` | bicep 参数 `workiqMode` | `auto` \| `live` \| `mock`，默认 `live` |
| `WORKIQ_TIMEOUT_MS` | bicep 参数 `timeoutMs` | 单次查询超时，默认 180000 |
| `PUBLIC_URL` | bicep 自动推导或参数 `publicUrl` | 对外 https 基址（无结尾斜杠），Teams tab/对话框地址取自它 |
| `ACCOUNT_MAP_FILE=/home/app/account-map.json` | bicep | Teams 用户 → Work IQ 账号映射，落在持久盘 |
| `MICROSOFT_APP_ID` | bicep 参数 `botAppId` | 留空则不启用 bot，只有 Web UI |
| `MICROSOFT_APP_PASSWORD` | bicep 参数 `botAppPassword`（secret `bot-app-password`） | |
| `MICROSOFT_APP_TENANT_ID` | bicep 参数 `botTenantId` | SingleTenant bot 才需要 |
| `ENROLL_TOKEN` | bicep 参数 `enrollToken`（secret `enroll-token`） | 保护 `POST /api/enroll`，留空则不校验 |
| `ENGINE_API_URL` | bicep 参数 `engineApiUrl` | 设了就是分离式拓扑（第 5 节），容器不再 spawn CLI |
| `npm_config_update_notifier=false` | Dockerfile（仅构建阶段） | 关掉 npm 更新提示，构建日志干净些 |

### `infra/main.bicep` 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `name` | `workiq-demo` | 容器应用名，同时派生 ACR / 存储账号 / 环境名 |
| `location` | 资源组区域 | |
| `image` | `''` | 镜像完整引用；为空则**只部署基础设施**，跳过容器应用 |
| `botAppId` / `botAppPassword` / `botTenantId` | `''` | Azure Bot 凭据 |
| `workiqMode` | `live` | |
| `enrollToken` | `''` | |
| `engineApiUrl` | `''` | |
| `publicUrl` | `''` | 留空则用 `https://<name>.<环境默认域名>` |
| `timeoutMs` | `180000` | |
| `fileShareQuotaGb` | `16` | |
| `logRetentionInDays` | `30` | |

### `scripts/deploy-azure.mjs` 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AZ_SUBSCRIPTION` | 当前 az 上下文 | 目标订阅 id |
| `RESOURCE_GROUP` | `workiq-demo-rg` | |
| `LOCATION` | `eastasia` | |
| `APP_NAME` | `workiq-demo` | 容器应用名 + 镜像名（小写字母/数字/连字符，3–24 位）|
| `MICROSOFT_APP_ID` | 空 | 提供时必须同时给密码，否则脚本直接报错退出 |
| `MICROSOFT_APP_PASSWORD` | 空 | |
| `MICROSOFT_APP_TENANT_ID` | 空 | |
| `WORKIQ_MODE` | `live` | |
| `ENROLL_TOKEN` | 空 | |
| `ENGINE_API_URL` | 空 | |
| `BOT_NAME` | `workiq-query-bot` | 要回写 endpoint 的 Azure Bot 资源名 |
| `BOT_RESOURCE_GROUP` | 同 `RESOURCE_GROUP` | Azure Bot 所在资源组 |
| `IMAGE_TAG` | `v<yyyymmddhhmmss>` | 镜像标签；同时也会打一个 `:latest` |
| `SKIP_BUILD` | 空 | `=1` 跳过 `az acr build`，直接用现有标签（默认 `latest`）重新部署 |
| `PERSIST_HOME` | `1` | `=0` 不创建存储账号/文件共享、不挂 `/home/app`（订阅策略禁用共享密钥/公网访问时必须这样，见 2.1）|

## 9. 更新与回滚

```bash
# 改了代码 -> 重新构建并部署（新标签 = 新修订）
node scripts/deploy-azure.mjs

# 回滚到上一个修订
az containerapp revision list -n workiq-demo -g workiq-demo-rg -o table
az containerapp revision activate -n workiq-demo -g workiq-demo-rg --revision <旧修订名>

# 只想换环境变量（例如切 mock 排查问题）
WORKIQ_MODE=mock SKIP_BUILD=1 node scripts/deploy-azure.mjs
```

挂了 Azure Files 时（`PERSIST_HOME=1`），镜像换了、容器重建，`/home/app` 里的 token 缓存和
`account-map.json` 都还在 —— 用户不需要重新登记；`PERSIST_HOME=0` 则会随重启丢失。

## 10. 部署记录模板

每次部署完把实际值填进这张表，交接时最省事（下面是一次 West US 2 部署的形态，标识符已用占位符代替）：

| 项 | 值 |
| --- | --- |
| 订阅 | `<subscription-id>` |
| 租户 | `<tenant-id>` |
| 资源组 | `<app-name>-rg`（`LOCATION`，本例 westus2）|
| Web UI / PUBLIC_URL | `https://<app-name>.<env-domain>.<region>.azurecontainerapps.io` |
| Messaging endpoint | `https://<app-name>.<env-domain>.<region>.azurecontainerapps.io/api/messages`（由 `deploy-azure.mjs` 回写到 Azure Bot）|
| 镜像 | `<acr-name>.azurecr.io/<app-name>:v<yyyymmddhhmmss>` |
| 引擎模式 | `mock`（匿名走示例数据；带 Teams SSO 的请求走真实 Work IQ，见 [SSO-OBO.md](SSO-OBO.md)）|
| `$HOME` 持久化 | `PERSIST_HOME=0`（订阅策略禁用存储账号共享密钥/公网访问时必须如此，见 2.1）|
| Azure Bot | `<app-name>-bot`（SingleTenant，Teams 频道已启用）|

一次真实部署的验收结果（同样的检查照做即可）：`GET /api/health` → `{"ok":true,"mode":"mock"}`；
`GET /?inTeams=1` 返回 200 且带 `frame-ancestors` CSP（Teams 可嵌）；`POST /api/ask` 返回带引用的答案；
`POST /api/messages` 未签名请求返回 401（Bot Framework 鉴权正常）；浏览器实测 Tab 视图可提问并渲染 Sources。
