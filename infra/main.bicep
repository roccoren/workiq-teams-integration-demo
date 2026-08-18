// WorkIQ Teams demo —— Azure Container Apps 部署拓扑
//
// 一次 `az deployment group create` 会创建：
//   ACR(Basic, admin) + Log Analytics + Container Apps 环境 + 存储账号/文件共享 + 容器应用
//
// 分两趟部署（scripts/deploy-azure.mjs 已经封装好）：
//   1) image='' —— 只建基础设施（此时 ACR 里还没有镜像），输出 acrName / 预测出的 fqdn；
//   2) `az acr build` 之后带上真实镜像再跑一次 —— 才创建/更新容器应用。
//   容器应用的 FQDN 是 `<name>.<环境 defaultDomain>`，环境建好就能算出来，
//   所以 PUBLIC_URL 不需要额外的第三趟或 `az containerapp update` 来回填。
//
// 关键约束：minReplicas = maxReplicas = 1。
//   `workiq mcp` 是 stdio 子进程，demo 按账号维护进程池，MSAL token 缓存也在实例本地的
//   $HOME 里；多副本会出现“用户在 A 副本登记、请求落到 B 副本”的情况，且 SMB 共享上的
//   token 缓存并发写不安全。要横向扩展必须换成 ENGINE_API_URL 分离式拓扑。

targetScope = 'resourceGroup'

@description('资源基础名，同时作为容器应用名（小写字母/数字/连字符）')
@minLength(3)
@maxLength(24)
param name string = 'workiq-demo'

@description('部署区域')
param location string = resourceGroup().location

@description('容器镜像完整引用，例如 myacr.azurecr.io/workiq-demo:v1。留空时只部署基础设施，不创建容器应用')
param image string = ''

@description('Azure Bot 的应用 (client) id；留空则容器只提供 Web UI')
param botAppId string = ''

@secure()
@description('Azure Bot 的客户端密码')
param botAppPassword string = ''

@description('SingleTenant bot 的租户 id；MultiTenant bot 留空')
param botTenantId string = ''

@description('引擎模式：auto | live | mock')
@allowed([
  'auto'
  'live'
  'mock'
])
param workiqMode string = 'live'

@secure()
@description('保护自助登记接口 POST /api/enroll 的令牌；留空表示不校验')
param enrollToken string = ''

@description('分离式拓扑：远程引擎地址（如 https://engine-host）。留空表示本容器内直接 spawn workiq mcp')
param engineApiUrl string = ''

@description('Azure Bot 的 OAuth 连接名（bot 侧 Teams SSO 用；见 scripts/setup-sso.mjs）。留空则 bot 走共享引擎')
param oauthConnectionName string = ''

@description('Work IQ hosted MCP 端点；留空用代码默认值 https://workiq.svc.cloud.microsoft/mcp')
param workiqMcpUrl string = ''

@description('OBO 换取的 Work IQ 委托 scope；留空用代码默认值 fdcc1f02-…/WorkIQAgent.Ask')
param workiqScope string = ''

@description('Teams 应用包 manifest 的 id；bot 的 /open 命令用它拼 tab 深链。留空则只提供对话框按钮')
param teamsAppId string = ''

@description('对外 https 基址；留空则由容器应用环境的默认域名推导')
param publicUrl string = ''

@description('单次 Work IQ 查询超时（毫秒）')
param timeoutMs int = 180000

@description('Azure Files 共享配额（GiB）')
param fileShareQuotaGb int = 16

@description('是否挂载 Azure Files 持久化 $HOME（token 缓存 / account-map.json）。订阅策略禁用存储账号共享密钥或公网访问时必须设为 false，否则容器挂载失败起不来')
param persistHome bool = true

@description('日志保留天数')
param logRetentionInDays int = 30

var suffix = uniqueString(resourceGroup().id)
var baseName = toLower(replace(replace(name, '-', ''), '_', ''))
var acrName = take('${baseName}acr${suffix}', 50)
var storageAccountName = take('${take(baseName, 10)}${suffix}', 24)
var shareName = 'workiq-home'
var volumeName = 'workiq-home'
// 与 Dockerfile 里的 `useradd --uid 1001 --home-dir /home/app` 一致
var homePath = '/home/app'
var appUid = 1001
var containerPort = 3000

// 外部 ingress 的 FQDN 形如 <应用名>.<环境默认域名>，环境建好即可预测
var appFqdn = '${name}.${containerAppsEnv.properties.defaultDomain}'
var trimmedPublicUrl = endsWith(publicUrl, '/') ? take(publicUrl, length(publicUrl) - 1) : publicUrl
var resolvedPublicUrl = empty(publicUrl) ? 'https://${appFqdn}' : trimmedPublicUrl

// ---- 容器镜像仓库 ----
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    // demo 简化：用 admin 账号拉镜像，省掉托管标识 + AcrPull 角色分配
    adminUserEnabled: true
    publicNetworkAccess: 'Enabled'
  }
}

// ---- 日志 ----
resource law 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${name}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionInDays
  }
}

// ---- 持久化：token 缓存 + account-map.json（订阅策略禁用共享密钥/公网访问时关掉）----
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = if (persistHome) {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    supportsHttpsTrafficOnly: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = if (persistHome) {
  parent: storage
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = if (persistHome) {
  parent: fileService
  name: shareName
  properties: {
    shareQuota: fileShareQuotaGb
    enabledProtocols: 'SMB'
  }
}

// ---- Container Apps 环境 ----
resource containerAppsEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: law.properties.customerId
        sharedKey: law.listKeys().primarySharedKey
      }
    }
  }
}

resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = if (persistHome) {
  parent: containerAppsEnv
  name: shareName
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: shareName
      accessMode: 'ReadWrite'
    }
  }
  dependsOn: [
    share
  ]
}

// 空值的密码/令牌不生成 secret，否则 ARM 会拒绝空 secret
var appSecrets = concat(
  [
    {
      name: 'acr-password'
      value: acr.listCredentials().passwords[0].value
    }
  ],
  empty(botAppPassword)
    ? []
    : [
        {
          name: 'bot-app-password'
          value: botAppPassword
        }
      ],
  empty(enrollToken)
    ? []
    : [
        {
          name: 'enroll-token'
          value: enrollToken
        }
      ]
)

var appEnv = concat(
  [
    {
      name: 'NODE_ENV'
      value: 'production'
    }
    {
      name: 'PORT'
      value: string(containerPort)
    }
    {
      name: 'HOME'
      value: homePath
    }
    {
      name: 'WORKIQ_MODE'
      value: workiqMode
    }
    {
      name: 'WORKIQ_TIMEOUT_MS'
      value: string(timeoutMs)
    }
    {
      name: 'PUBLIC_URL'
      value: resolvedPublicUrl
    }
    {
      // 挂载卷上的映射文件：Teams 用户 -> Work IQ 账号，重启后仍在
      name: 'ACCOUNT_MAP_FILE'
      value: '${homePath}/account-map.json'
    }
  ],
  empty(botAppId)
    ? []
    : [
        {
          name: 'MICROSOFT_APP_ID'
          value: botAppId
        }
      ],
  empty(botAppPassword)
    ? []
    : [
        {
          name: 'MICROSOFT_APP_PASSWORD'
          secretRef: 'bot-app-password'
        }
      ],
  empty(botTenantId)
    ? []
    : [
        {
          name: 'MICROSOFT_APP_TENANT_ID'
          value: botTenantId
        }
      ],
  empty(enrollToken)
    ? []
    : [
        {
          name: 'ENROLL_TOKEN'
          secretRef: 'enroll-token'
        }
      ],
  empty(engineApiUrl)
    ? []
    : [
        {
          name: 'ENGINE_API_URL'
          value: engineApiUrl
        }
      ],
  empty(oauthConnectionName)
    ? []
    : [
        {
          name: 'OAUTH_CONNECTION_NAME'
          value: oauthConnectionName
        }
      ],
  empty(workiqMcpUrl)
    ? []
    : [
        {
          name: 'WORKIQ_MCP_URL'
          value: workiqMcpUrl
        }
      ],
  empty(workiqScope)
    ? []
    : [
        {
          name: 'WORKIQ_SCOPE'
          value: workiqScope
        }
      ],
  empty(teamsAppId)
    ? []
    : [
        {
          name: 'TEAMS_APP_ID'
          value: teamsAppId
        }
      ]
)

// ---- 容器应用（第一趟 image 为空时跳过）----
resource containerApp 'Microsoft.App/containerApps@2024-03-01' = if (!empty(image)) {
  name: name
  location: location
  properties: {
    environmentId: containerAppsEnv.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: containerPort
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: acr.properties.loginServer
          username: acr.listCredentials().username
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: appSecrets
    }
    template: {
      containers: [
        {
          name: 'app'
          image: image
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: appEnv
          volumeMounts: persistHome
            ? [
                {
                  volumeName: volumeName
                  mountPath: homePath
                }
              ]
            : []
          probes: [
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health'
                port: containerPort
              }
              initialDelaySeconds: 10
              periodSeconds: 10
              failureThreshold: 6
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health'
                port: containerPort
              }
              initialDelaySeconds: 30
              periodSeconds: 30
              failureThreshold: 5
            }
          ]
        }
      ]
      // 必须单副本：stdio 进程池 + 每账号 token 缓存都是实例本地状态
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: persistHome
        ? [
            {
              name: volumeName
              storageType: 'AzureFile'
              storageName: envStorage.name
              // SMB 默认挂成 root 所有；按容器内的 app(uid/gid 1001) 授权，并收紧到仅属主可读写。
              // mfsymlinks/nobrl 让 .NET/MSAL 的缓存文件与锁在 CIFS 上正常工作。
              mountOptions: 'uid=${appUid},gid=${appUid},dir_mode=0700,file_mode=0600,mfsymlinks,nobrl'
            }
          ]
        : []
    }
  }
}

output fqdn string = appFqdn
output messagingEndpoint string = 'https://${appFqdn}/api/messages'
output publicUrl string = resolvedPublicUrl
output acrLoginServer string = acr.properties.loginServer
output acrName string = acr.name
output storageAccountName string = persistHome ? storage.name : ''
output fileShareName string = persistHome ? shareName : ''
output homePersisted bool = persistHome
output appDeployed bool = !empty(image)
