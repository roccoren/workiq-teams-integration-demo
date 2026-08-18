#!/usr/bin/env node
/**
 * 一键部署 Teams Bot 到指定租户并上传应用（配合 az CLI）。
 *
 * 用法（先 az login 到目标租户）:
 *   TARGET_TENANT_ID=<租户id> node scripts/deploy-teams.mjs
 *   TARGET_TENANT_ID=<租户id> UPLOAD=1 node scripts/deploy-teams.mjs     # 尝试 Graph 上传
 *   TARGET_TENANT_ID=<租户id> BOT_APP_ID=<已有appId> node scripts/deploy-teams.mjs
 *
 * 环境变量:
 *   TARGET_TENANT_ID  目标租户 id（必填）
 *   AZ_SUBSCRIPTION   目标租户内的订阅 id（默认使用当前 az 上下文）
 *   BOT_APP_ID        已有 bot 的 App Registration id（可选，缺省则新建）
 *   BOT_NAME          机器人名（默认 workiq-query-bot）
 *   BOT_APP_TYPE      MultiTenant | SingleTenant（默认 MultiTenant）
 *   BOT_RESOURCE_GROUP 资源组（默认 workiq-demo-rg）
 *   MESSAGING_ENDPOINT 公网 https 端点（默认取 PUBLIC_URL 或当前 localhost.run/ngrok 隧道）
 *   TEAMS_APP_ID      Teams 应用 id（默认随机 GUID，用于 sideload）
 *   UPLOAD=1         上传到目标租户的 Teams 应用目录（需要 Graph AppCatalog.ReadWrite.All 授权）
 *   WORKIQ_CONSENT_CLIENT 默认 ba081686-5d24-4bc6-a0d6-d034ecffed87
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const step = (msg) => console.log("\n==> " + msg);
const sh = (cmd, args, opts = {}) => {
  try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim(); }
  catch (e) { throw new Error(`${cmd} ${args.join(" ")} 失败: ${e.stderr?.toString().slice(0, 500) ?? e.message}`); }
};

const tenant = process.env.TARGET_TENANT_ID;
if (!tenant) { console.error("缺少 TARGET_TENANT_ID"); process.exit(2); }
const sub = process.env.AZ_SUBSCRIPTION;
const botName = process.env.BOT_NAME ?? "workiq-query-bot";
const appType = process.env.BOT_APP_TYPE ?? "MultiTenant";
const rg = process.env.BOT_RESOURCE_GROUP ?? "workiq-demo-rg";
const existingAppId = process.env.BOT_APP_ID;
const teamsAppId = process.env.TEAMS_APP_ID ?? randomUUID();
const upload = process.env.UPLOAD === "1";
const consentClient = process.env.WORKIQ_CONSENT_CLIENT ?? "ba081686-5d24-4bc6-a0d6-d034ecffed87";
// 多租户并行部署时给每个租户一份凭据文件：BOT_ENV_FILE=.env.bot.contoso
const botEnvFile = path.resolve(root, process.env.BOT_ENV_FILE ?? ".env.bot");
const zipPath = path.resolve(root, process.env.TEAMS_APP_ZIP ?? "teams/workiq-demo.zip");

// ---- 0. 检查 az 登录 + 目标租户可达 ----
step("0. 检查 az 登录");
const who = JSON.parse(sh("az", ["account", "show", "--query", "{tenant:tenantId,user:user.name}", "-o", "json"]));
console.log("当前 az 身份:", who.user, "| 租户:", who.tenant);
if (who.tenant.toLowerCase() !== tenant.toLowerCase() && !sub) {
  console.error(`目标租户 ${tenant} 与当前 az 登录租户 ${who.tenant} 不一致，请先: az login --tenant ${tenant}（或用 AZ_SUBSCRIPTION 指定该租户内的订阅）`);
  process.exit(2);
}
if (sub) { sh("az", ["account", "set", "-s", sub]); console.log("已切换到订阅:", sub); }

// ---- 1. 准备 App Registration（复用或新建）----
let appId = existingAppId;
let clientSecret = process.env.BOT_APP_SECRET;
if (!clientSecret) {
  try {
    const envBot = fs.readFileSync(botEnvFile, "utf8");
    const m = envBot.match(/MICROSOFT_APP_PASSWORD=(.+)/);
    if (m) clientSecret = m[1].trim();
  } catch { /* 没有凭据文件 */ }
}
if (!appId) {
  step("1. 创建 App Registration");
  const audience = appType === "SingleTenant" ? "AzureADMyOrg" : "AzureADMultipleOrgs";
  const app = JSON.parse(sh("az", ["ad", "app", "create", "--display-name", botName, "--sign-in-audience", audience, "-o", "json"]));
  appId = app.appId;
  console.log("App Registration appId:", appId);
}
if (!clientSecret) {
  step("2. 创建 client secret");
  const cred = JSON.parse(sh("az", ["ad", "app", "credential", "reset", "--id", appId, "--display-name", "workiq-demo", "-o", "json"]));
  clientSecret = cred.password;
  fs.writeFileSync(botEnvFile, `MICROSOFT_APP_ID=${appId}\nMICROSOFT_APP_PASSWORD=${clientSecret}\n`, { mode: 0o600 });
  console.log(`secret 已写入 ${path.relative(root, botEnvFile)}（权限 600）`);
}

// ---- 3. 创建/定位 Azure Bot 资源 ----
step("3. 定位/创建 Azure Bot 资源（" + appType + "）");
const { execa } = { execa: null }; // not used
try {
  // bot may have been moved by a region-migration; find it wherever it is
  const found = sh("az", ["resource", "list", "--subscription", sub ?? "", "--resource-type", "Microsoft.BotService/botServices", "-o", "json"], sub ? {} : { env: { ...process.env } });
  const bots = JSON.parse(found);
  const existing = bots.find((b) => b.name === botName);
  if (existing) {
    const rg2 = existing.id.split("/")[4];
    console.log("Bot 已存在于资源组:", rg2);
    const endpointNow = process.env.MESSAGING_ENDPOINT ?? process.env.PUBLIC_URL ?? "";
    if (endpointNow) {
      sh("az", ["bot", "update", "--name", botName, "-g", rg2, "--subscription", sub ?? "", "--endpoint", endpointNow.replace(/\/$/, "") + "/api/messages", "-o", "json"]);
      console.log("已更新 endpoint 到:", endpointNow + "/api/messages");
    }
    process.exit(0);
  }
} catch (e) {
  console.warn("定位 bot 失败（可能尚未创建），继续创建…", e.message);
}
try { sh("az", ["group", "create", "--name", rg, "--location", "eastasia", "-o", "none"]); } catch { /* 已存在 */ }
const endpoint = (process.env.MESSAGING_ENDPOINT ?? process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
if (!endpoint) { console.warn("未提供 MESSAGING_ENDPOINT/PUBLIC_URL，先创建 bot 资源，稍后手动填 endpoint"); }
const botArgs = ["bot", "create", "--name", botName, "-g", rg, "--app-type", appType, "--appid", appId, "--tenant-id", tenant, "--sku", "F0", "-o", "json"];
if (endpoint) botArgs.push("--endpoint", endpoint + "/api/messages");
const bot = JSON.parse(sh("az", botArgs));
console.log("Bot 资源已创建:", bot.id);
if (endpoint) {
  step("3b. 设置 messaging endpoint");
  sh("az", ["bot", "update", "--name", botName, "-g", rg, "--endpoint", endpoint + "/api/messages", "-o", "none"]);
  console.log("messaging endpoint:", endpoint + "/api/messages");
}

// ---- 4. 生成 Teams 应用包 ----
step("4. 生成 Teams manifest + zip");
process.env.TEAMS_APP_ID = teamsAppId;
process.env.TEAMS_BOT_ID = appId;
process.env.TEAMS_APP_NAME = process.env.TEAMS_APP_NAME ?? "WorkIQ Query Assistant";
sh(process.execPath, [path.join(here, "generate-manifest.mjs")], { env: process.env });
sh(process.execPath, [path.join(here, "pack-teams-app.mjs"), zipPath], { env: process.env, stdio: ["ignore", "inherit", "inherit"] });

// ---- 5. 上传到目标租户 Teams 目录 ----
let uploadStatus = "跳过（UPLOAD=1 可启用）";
if (upload) {
  step("5. 上传 Teams 应用到 " + tenant);
  try {
    const out = sh("az", ["rest", "--method", "POST", "--url", "https://graph.microsoft.com/v1.0/appCatalogs/teamsApps", "--headers", "Content-Type=application/zip", "--body", "@" + zipPath, "--resource", "https://graph.microsoft.com"]);
    console.log("上传成功:", out.slice(0, 300));
    uploadStatus = "已上传（appCatalog）";
  } catch (e) {
    uploadStatus = "上传失败，请手动上传: " + e.message;
    console.error(uploadStatus);
  }
}

// ---- 6. 输出下一步 ----
step("6. 完成 — 下一步");
console.log(`
  目标租户      : ${tenant}
  Bot appId    : ${appId}   (secret 在 .env.bot)
  Teams 应用 id : ${teamsAppId}
  应用包        : ${zipPath}
  上传状态      : ${uploadStatus}
  Messaging    : ${endpoint ? endpoint + "/api/messages" : "(未设置，请在 Azure Bot -> Configuration 填写)"}

  demo 启用（引擎主机）:
    MICROSOFT_APP_ID=${appId} MICROSOFT_APP_PASSWORD=<secret 见 .env.bot> WORKIQ_MODE=live npm start

  WorkIQ 管理员同意（目标租户，一次性）:
    https://login.microsoftonline.com/${tenant}/adminconsent?client_id=${consentClient}

  目标租户内登录 WorkIQ 账号（每账号一次）:
    npx -y @microsoft/workiq auth login --account <目标租户内的邮箱>

  手动上传（如未启用 UPLOAD）:
    Teams 管理后台 -> 应用 -> 上传自定义应用 -> ${zipPath}
`);