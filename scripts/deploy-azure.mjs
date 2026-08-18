#!/usr/bin/env node
/**
 * 一键把 demo 部署到 Azure Container Apps（ACR 服务端构建镜像，本机不需要 Docker）。
 *
 * 用法（先 az login）:
 *   MICROSOFT_APP_ID=<botAppId> MICROSOFT_APP_PASSWORD=<secret> node scripts/deploy-azure.mjs
 *   SKIP_BUILD=1 node scripts/deploy-azure.mjs          # 只重新部署，不重建镜像
 *   WORKIQ_MODE=mock node scripts/deploy-azure.mjs      # 先用 mock 模式跑通链路
 *
 * 环境变量:
 *   AZ_SUBSCRIPTION        订阅 id（默认使用当前 az 上下文）
 *   RESOURCE_GROUP         资源组（默认 workiq-demo-rg）
 *   LOCATION               区域（默认 eastasia）
 *   APP_NAME               容器应用/镜像名（默认 workiq-demo）
 *   MICROSOFT_APP_ID       Azure Bot 的 appId（可选；没有则只部署 Web UI）
 *   MICROSOFT_APP_PASSWORD Azure Bot 的客户端密码
 *   MICROSOFT_APP_TENANT_ID SingleTenant bot 的租户 id（MultiTenant 留空）
 *   WORKIQ_MODE            auto | live | mock（默认 live）
 *   ENROLL_TOKEN           保护 POST /api/enroll 的令牌（可选）
 *   ENGINE_API_URL         分离式拓扑：远程引擎地址（可选，见 docs/AZURE.md）
 *   BOT_NAME               Azure Bot 资源名（默认 workiq-query-bot），用于回写 messaging endpoint
 *   BOT_RESOURCE_GROUP     Azure Bot 所在资源组（默认与 RESOURCE_GROUP 相同）
 *   IMAGE_TAG              镜像标签（默认按时间戳生成）
 *   SKIP_BUILD=1           跳过 az acr build，直接用 IMAGE_TAG（默认 latest）重新部署
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const step = (msg) => console.log("\n==> " + msg);
const sh = (cmd, args, opts = {}) => {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: root, ...opts });
    return typeof out === "string" ? out.trim() : "";
  } catch (e) {
    throw new Error(`${cmd} ${args.join(" ")} 失败: ${e.stderr?.toString().slice(0, 800) ?? e.message}`);
  }
};
// 长任务（镜像构建）直接把输出透传到终端
const shLive = (cmd, args) => sh(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
const fail = (msg) => { console.error("\n✗ " + msg); process.exit(2); };

const sub = process.env.AZ_SUBSCRIPTION;
const rg = process.env.RESOURCE_GROUP ?? "workiq-demo-rg";
const location = process.env.LOCATION ?? "eastasia";
const appName = process.env.APP_NAME ?? "workiq-demo";
const botAppId = process.env.MICROSOFT_APP_ID ?? "";
const botAppPassword = process.env.MICROSOFT_APP_PASSWORD ?? "";
const botTenantId = process.env.MICROSOFT_APP_TENANT_ID ?? "";
const mode = (process.env.WORKIQ_MODE ?? "live").toLowerCase();
const enrollToken = process.env.ENROLL_TOKEN ?? "";
const engineApiUrl = process.env.ENGINE_API_URL ?? "";
const botName = process.env.BOT_NAME ?? "workiq-query-bot";
const botRg = process.env.BOT_RESOURCE_GROUP ?? rg;
const skipBuild = process.env.SKIP_BUILD === "1";
// 订阅策略禁用存储账号共享密钥/公网访问时（Azure Files SMB 挂不上），设 PERSIST_HOME=0
const persistHome = process.env.PERSIST_HOME !== "0";
const oauthConnectionName = process.env.OAUTH_CONNECTION_NAME ?? "";
const workiqMcpUrl = process.env.WORKIQ_MCP_URL ?? "";
const workiqScope = process.env.WORKIQ_SCOPE ?? "";
// CLI/stdio 拓扑才需要把 ~146 MB 的 Work IQ CLI 打进镜像；Teams SSO + OBO 不需要。
// 显式 INCLUDE_WORKIQ_CLI=1 优先，否则只有“本容器内跑 live 引擎”时才自动带上。
const includeCli = process.env.INCLUDE_WORKIQ_CLI === "1"
  || (process.env.INCLUDE_WORKIQ_CLI !== "0" && mode === "live" && !engineApiUrl);
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const imageTag = process.env.IMAGE_TAG ?? (skipBuild ? "latest" : `v${stamp}`);

if (!["auto", "live", "mock"].includes(mode)) fail(`WORKIQ_MODE 必须是 auto|live|mock，当前 "${mode}"`);
if (!/^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/.test(appName)) fail(`APP_NAME "${appName}" 不合法（小写字母/数字/连字符，3-24 位）`);
const bicep = path.join(root, "infra", "main.bicep");
if (!fs.existsSync(bicep)) fail(`找不到 ${bicep}`);
if (!fs.existsSync(path.join(root, "Dockerfile"))) fail("找不到 Dockerfile");
if (botAppId && !botAppPassword) fail("提供了 MICROSOFT_APP_ID 就必须同时提供 MICROSOFT_APP_PASSWORD（见 .env.bot）");

// ---- 0. 检查 az 登录 ----
step("0. 检查 az 登录");
let who;
try {
  who = JSON.parse(sh("az", ["account", "show", "--query", "{tenant:tenantId,user:user.name,sub:id}", "-o", "json"]));
} catch {
  fail("az 未登录或未安装。先执行 `az login`（安装: https://aka.ms/azcli）");
}
if (sub) {
  sh("az", ["account", "set", "-s", sub]);
  console.log("已切换到订阅:", sub);
} else {
  console.log("当前订阅:", who.sub);
}
console.log("身份:", who.user, "| 租户:", who.tenant);

// ---- 1. 注册资源提供程序（幂等，已注册时秒回）----
step("1. 注册资源提供程序");
for (const ns of ["Microsoft.App", "Microsoft.OperationalInsights", "Microsoft.ContainerRegistry", "Microsoft.Storage"]) {
  try { sh("az", ["provider", "register", "--namespace", ns, "-o", "none"]); console.log("  ok", ns); }
  catch (e) { console.warn("  跳过", ns, "(", e.message.slice(0, 120), ")"); }
}

// ---- 2. 资源组 ----
step(`2. 资源组 ${rg} (${location})`);
sh("az", ["group", "create", "--name", rg, "--location", location, "-o", "none"]);

// bicep 参数（两趟部署共用，只有 image 不同）
const baseParams = [
  `name=${appName}`,
  `location=${location}`,
  `workiqMode=${mode}`,
  `botAppId=${botAppId}`,
  `botAppPassword=${botAppPassword}`,
  `botTenantId=${botTenantId}`,
  `enrollToken=${enrollToken}`,
  `engineApiUrl=${engineApiUrl}`,
  `persistHome=${persistHome}`,
  `oauthConnectionName=${oauthConnectionName}`,
  `workiqMcpUrl=${workiqMcpUrl}`,
  `workiqScope=${workiqScope}`,
  `teamsAppId=${process.env.TEAMS_APP_ID ?? ""}`,
];
const deploy = (deploymentName, image) => {
  const args = ["deployment", "group", "create", "-g", rg, "-n", deploymentName, "-f", bicep, "-p", ...baseParams, `image=${image}`, "--query", "properties.outputs", "-o", "json"];
  return JSON.parse(sh("az", args));
};

// ---- 3. 基础设施（ACR / 日志 / 环境 / 文件共享）----
step(`3. 部署基础设施（ACR + Log Analytics + Container Apps 环境${persistHome ? " + Azure Files" : "，PERSIST_HOME=0：不挂载 Azure Files"}）`);
const infra = deploy(`${appName}-infra`, "");
const acrName = infra.acrName.value;
const acrLoginServer = infra.acrLoginServer.value;
const fqdn = infra.fqdn.value;
console.log("  ACR      :", acrLoginServer);
console.log("  文件共享 :", persistHome ? `${infra.storageAccountName.value}/${infra.fileShareName.value}` : "未挂载（$HOME 不持久化）");
console.log("  预期域名 :", fqdn);

// ---- 4. 服务端构建镜像 ----
const imageRef = `${acrLoginServer}/${appName}:${imageTag}`;
if (skipBuild) {
  step(`4. 跳过镜像构建（SKIP_BUILD=1），沿用 ${imageRef}`);
} else {
  step(`4. 在 ACR 里构建镜像 ${appName}:${imageTag}（服务端构建，本机不需要 Docker）${includeCli ? " · 含 Work IQ CLI" : " · 不含 CLI（SSO/OBO 路径）"}`);
  shLive("az", ["acr", "build", "--registry", acrName, "-g", rg, "--file", "Dockerfile",
    "--build-arg", `INCLUDE_WORKIQ_CLI=${includeCli}`,
    "--image", `${appName}:${imageTag}`, "--image", `${appName}:latest`, "."]);
}

// ---- 5. 部署容器应用（PUBLIC_URL 由环境默认域名推导，无需第二次回填）----
step("5. 部署容器应用");
const app = deploy(`${appName}-app`, imageRef);
const publicUrl = app.publicUrl.value;
const messagingEndpoint = app.messagingEndpoint.value;
console.log("  PUBLIC_URL:", publicUrl);

// ---- 6. 回写 Azure Bot 的 messaging endpoint ----
step("6. 更新 Azure Bot 的 messaging endpoint");
let botStatus;
if (!botAppId) {
  botStatus = "跳过（未提供 MICROSOFT_APP_ID）";
} else {
  try {
    sh("az", ["bot", "show", "--name", botName, "-g", botRg, "-o", "none"]);
    sh("az", ["bot", "update", "--name", botName, "-g", botRg, "--endpoint", messagingEndpoint, "-o", "none"]);
    botStatus = `${botName} -> ${messagingEndpoint}`;
    console.log(" ", botStatus);
  } catch (e) {
    botStatus = `失败，请在 Azure Bot -> Configuration 手工填写 ${messagingEndpoint}`;
    console.warn("  未能更新 bot（", e.message.slice(0, 200), "）");
  }
}

// ---- 7. 下一步 ----
step("7. 完成 — 下一步");
console.log(`
  Web UI       : ${publicUrl}
  健康检查     : ${publicUrl}/api/health
  Messaging    : ${messagingEndpoint}   (${botStatus})
  镜像         : ${imageRef}
  引擎模式     : ${mode}${engineApiUrl ? ` (远程引擎 ${engineApiUrl})` : ""}
  副本数       : 固定 1（stdio 进程池 + token 缓存是实例本地状态）
  $HOME 持久化 : ${persistHome ? "Azure Files 共享（重启/换镜像不丢）" : "无（PERSIST_HOME=0；重启后 token 缓存与 account-map.json 会丢）"}

  1) 重新生成并上传 Teams 应用包（tab/dialog 用的就是 PUBLIC_URL）:
       PUBLIC_URL=${publicUrl} TEAMS_BOT_ID=${botAppId || "<botAppId>"} node scripts/generate-manifest.mjs
       node scripts/pack-teams-app.mjs
       Teams 管理后台 -> 应用 -> 上传自定义应用

  2) Work IQ 账号授权（live 模式必需；mock 模式跳过）:
       容器里的 \`workiq auth login\` 依赖桌面版 MSAL broker，无头环境完不成 —— 二选一：
       a. ${persistHome ? "在能登录的机器上登录一次，把 $HOME 里的 token 缓存上传到共享 workiq-home（docs/AZURE.md 第 4 节路线 2，未验证）" : "（当前部署未挂载共享，路线 2 不可用）"}
       b. 改用分离式拓扑：ENGINE_API_URL=<引擎主机> 重新部署（docs/AZURE.md 第 5 节）
       自助登记页（CLI 支持无头 device code 后即可用）: ${publicUrl}${enrollToken ? `/?token=${enrollToken}` : ""}

  3) 查看日志:
       az containerapp logs show -n ${appName} -g ${rg} --follow
`);
