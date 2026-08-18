#!/usr/bin/env node
/**
 * 完整的新租户部署入口。
 *
 *   cp .env.tenant.example .env.contoso
 *   # 编辑 TARGET_TENANT_ID / AZ_SUBSCRIPTION / APP_NAME；在管理门户完成计费策略后
 *   BILLING_POLICY_READY=1 node scripts/onboard-tenant.mjs .env.contoso
 *
 * 允许的人工前置条件只有两类，脚本会在改变资源前拦住：
 *   1. Copilot Credits 计费策略（真实按量计费，不能静默绑定订阅）；
 *   2. Teams 应用包上传（目录管理员交互动作）。
 *
 * 其他动作全自动、全幂等：Work IQ 服务主体/授权、App Registration/Bot、Azure、SSO/OBO、应用包、验收。
 *
 * 选项：
 *   --dry-run                只检查本地参数、az 上下文与计费策略，不改任何资源
 *   --allow-billing-pending  允许在未确认计费策略时部署 mock 链路；最终会明确标记“真实数据不可用”
 *   STEPS=1,2,3,4,5          只执行指定步骤（恢复中断的部署）
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = new Set(process.argv.slice(2));
const envFileArg = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? process.env.TENANT_ENV;
const dryRun = args.has("--dry-run");
const allowBillingPending = args.has("--allow-billing-pending");

const step = (title) => console.log(`\n${"=".repeat(76)}\n== ${title}\n${"=".repeat(76)}`);
const fail = (message) => { console.error(`\n✗ ${message}`); process.exit(2); };
const info = (message) => console.log(`  • ${message}`);

function run(command, commandArgs, options = {}) {
  try {
    return execFileSync(command, commandArgs, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch (error) {
    const detail = (error.stderr || error.stdout || error.message || "").toString().trim();
    throw new Error(`${command} ${commandArgs.join(" ")}\n${detail}`);
  }
}

function runLive(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    ...options,
  });
}

if (!envFileArg) fail("用法: node scripts/onboard-tenant.mjs <参数文件> [--dry-run]  （模板: .env.tenant.example）");
const envPath = path.resolve(root, envFileArg);
if (!fs.existsSync(envPath)) fail(`找不到参数文件: ${envPath}`);

const params = {};
for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!match) fail(`${envFileArg} 有无法解析的行: ${raw}`);
  params[match[1]] = match[2].replace(/^["']|["']$/g, "");
}

const required = ["TARGET_TENANT_ID", "AZ_SUBSCRIPTION", "APP_NAME"];
const missing = required.filter((name) => !params[name]);
if (missing.length) fail(`参数文件缺少必填项: ${missing.join(", ")}`);
if (!/^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/.test(params.APP_NAME)) {
  fail(`APP_NAME "${params.APP_NAME}" 不合法（小写字母/数字/连字符，3–24 位）`);
}

const alias = params.TENANT_ALIAS || params.APP_NAME;
const rg = params.RESOURCE_GROUP || `${params.APP_NAME}-rg`;
const botName = params.BOT_NAME || `${params.APP_NAME}-bot`;
const botEnvFile = params.BOT_ENV_FILE || `.env.bot.${alias}`;
const zipPath = params.TEAMS_APP_ZIP || `teams/${params.APP_NAME}.zip`;
const statePath = `.deploy-state.${alias}.json`;
const steps = new Set((process.env.STEPS || "1,2,3,4,5").split(",").map((value) => value.trim()));
const botType = params.BOT_APP_TYPE || "SingleTenant";
if (!["SingleTenant", "MultiTenant"].includes(botType)) fail("BOT_APP_TYPE 只能是 SingleTenant 或 MultiTenant");

const base = {
  ...process.env,
  ...params,
  TARGET_TENANT_ID: params.TARGET_TENANT_ID,
  AZ_SUBSCRIPTION: params.AZ_SUBSCRIPTION,
  RESOURCE_GROUP: rg,
  BOT_RESOURCE_GROUP: params.BOT_RESOURCE_GROUP || rg,
  LOCATION: params.LOCATION || "westus2",
  BOT_NAME: botName,
  BOT_APP_TYPE: botType,
  BOT_ENV_FILE: botEnvFile,
  TEAMS_APP_ZIP: zipPath,
  MICROSOFT_APP_TENANT_ID: params.TARGET_TENANT_ID,
  WORKIQ_MODE: params.WORKIQ_MODE || "mock",
  PERSIST_HOME: params.PERSIST_HOME ?? "0",
  OAUTH_CONNECTION_NAME: params.OAUTH_CONNECTION_NAME || "workiq",
  CONSENT: params.CONSENT ?? "1",
};

function loadEnvFile(file) {
  const absolute = path.resolve(root, file);
  if (!fs.existsSync(absolute)) return {};
  const values = {};
  for (const raw of fs.readFileSync(absolute, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(raw.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function saveState(state) {
  const out = path.resolve(root, statePath);
  fs.writeFileSync(out, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  return out;
}

function loadState() {
  const file = path.resolve(root, statePath);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { fail(`部署状态文件不是合法 JSON: ${statePath}`); }
}

function script(name, extra = {}) {
  runLive(process.execPath, [path.join(here, name)], { env: { ...base, ...extra } });
}

function graphBillingPolicies() {
  try {
    const token = run("az", ["account", "get-access-token", "--resource", "https://api.powerplatform.com/", "--query", "accessToken", "-o", "tsv"]);
    const output = run("curl", ["-sS", "--max-time", "20", "-H", `Authorization: Bearer ${token}`,
      "https://api.powerplatform.com/licensing/billingPolicies?api-version=2022-03-01-preview"]);
    return JSON.parse(output).value ?? [];
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

step("0. 预检：工具、租户、订阅、参数");
for (const binary of ["az", "node", "curl"]) {
  try { run(binary, [binary === "node" ? "--version" : "--version"]); }
  catch { fail(`找不到 ${binary}；安装后重试`); }
}
const nodeVersion = Number(process.versions.node.split(".")[0]);
if (nodeVersion < 20) fail(`Node ${process.versions.node} 不受支持；需要 Node 20+`);
const account = JSON.parse(run("az", ["account", "show", "--query", "{tenant:tenantId,user:user.name,sub:id}", "-o", "json"]));
if (account.tenant.toLowerCase() !== params.TARGET_TENANT_ID.toLowerCase()) {
  fail(`当前 az 在租户 ${account.tenant}，目标是 ${params.TARGET_TENANT_ID}。先执行：az login --tenant ${params.TARGET_TENANT_ID}`);
}
runLive("az", ["account", "set", "-s", params.AZ_SUBSCRIPTION]);
const subscription = JSON.parse(run("az", ["account", "show", "--query", "{tenant:tenantId,user:user.name,sub:id,name:name}", "-o", "json"]));
if (subscription.sub.toLowerCase() !== params.AZ_SUBSCRIPTION.toLowerCase()) fail(`无法切换到订阅 ${params.AZ_SUBSCRIPTION}`);
info(`身份 ${subscription.user} · 租户 ${subscription.tenant} · 订阅 ${subscription.name}`);
info(`资源组 ${rg} · 区域 ${base.LOCATION} · Bot ${botName} (${botType})`);
info(`凭据文件 ${botEnvFile} · 包 ${zipPath} · 状态 ${statePath}`);

step("0b. 必要的人工计费前置条件");
const policies = graphBillingPolicies();
if (Array.isArray(policies)) {
  if (policies.length === 0) {
    console.log("  ✗ Power Platform 返回 0 条 billing policy。Work IQ 数据面将一律返回 not entitled。");
  } else {
    console.log(`  ? 检测到 ${policies.length} 条 billing policy；公开 API 不返回 Work IQ API 的激活/覆盖明细，仍须在门户确认。`);
  }
} else {
  console.log(`  ? 无法读取 billingPolicies：${policies.error}`);
}
const billingConfirmed = base.BILLING_POLICY_READY === "1";
if (dryRun) {
  console.log("\n✓ dry-run 完成：未创建、修改或删除任何资源。");
  process.exit(0);
}
if (!billingConfirmed && !allowBillingPending) {
  fail(`未确认 Copilot Credits 计费策略。先在 https://admin.cloud.microsoft/ → Copilot → Cost management → Configuration 创建并**激活**覆盖 “Work IQ API” 的策略，再在参数文件写 BILLING_POLICY_READY=1。\n\n只想先部署 mock/Teams 链路可加 --allow-billing-pending；真实 Work IQ 数据仍不可用。`);
}
if (!billingConfirmed) console.log("  ! 已允许计费待配置：本次只保证 mock/Teams/SSO 链路，真实 Work IQ 数据面仍会 Forbidden。");
else console.log("  ✓ 操作者已确认 BILLING_POLICY_READY=1（仍建议在门户确认 Work IQ API 出现在 Pay-as-you-go services）。");

if (steps.has("1")) {
  step("1. 启用目标租户的 Work IQ");
  script("enable-workiq-tenant.mjs");
}

if (steps.has("2")) {
  step("2. 创建/复用 App Registration 与 Azure Bot");
  script("deploy-teams.mjs");
}

const bot = { ...loadEnvFile(botEnvFile), MICROSOFT_APP_ID: params.BOT_APP_ID || loadEnvFile(botEnvFile).MICROSOFT_APP_ID,
  MICROSOFT_APP_PASSWORD: params.BOT_APP_SECRET || loadEnvFile(botEnvFile).MICROSOFT_APP_PASSWORD };
if (!bot.MICROSOFT_APP_ID || !bot.MICROSOFT_APP_PASSWORD) {
  fail(`缺少 bot 凭据：${botEnvFile} 必须有 MICROSOFT_APP_ID/MICROSOFT_APP_PASSWORD，或参数文件配置 BOT_APP_ID/BOT_APP_SECRET`);
}

// deploy-teams 已生成初始 manifest，提取其 app id；允许参数文件显式覆盖，以便更新既有 Teams app。
let teamsAppId = params.TEAMS_APP_ID;
const generatedManifest = path.join(root, "teams", "appPackage", "manifest.json");
if (!teamsAppId && fs.existsSync(generatedManifest)) {
  teamsAppId = JSON.parse(fs.readFileSync(generatedManifest, "utf8")).id;
}
if (!teamsAppId) fail("拿不到 TEAMS_APP_ID：先跑步骤 2，或在参数文件填写 TEAMS_APP_ID");
const teamsVersion = params.TEAMS_APP_VERSION || "1.0.0";

if (steps.has("3")) {
  step("3. 部署 Azure Container Apps");
  script("deploy-azure.mjs", { ...bot, TEAMS_APP_ID: teamsAppId, TEAMS_APP_VERSION: teamsVersion, OAUTH_CONNECTION_NAME: "" });
}

const fqdn = run("az", ["containerapp", "show", "-n", params.APP_NAME, "-g", rg, "--subscription", params.AZ_SUBSCRIPTION,
  "--query", "properties.configuration.ingress.fqdn", "-o", "tsv"]);
if (!fqdn) fail("拿不到 Container App FQDN；步骤 3 没有成功完成");
const publicUrl = `https://${fqdn}`;
info(`PUBLIC_URL = ${publicUrl}`);

if (steps.has("4")) {
  step("4. 配置 Teams SSO + OBO + WorkIQAgent.Ask");
  script("setup-sso.mjs", {
    ...bot,
    APP_ID: bot.MICROSOFT_APP_ID,
    APP_SECRET: bot.MICROSOFT_APP_PASSWORD,
    PUBLIC_URL: publicUrl,
    TENANT_ID: params.TARGET_TENANT_ID,
  });
  step("4b. 回写 SSO/OAuth/Teams App ID 到运行时环境");
  script("deploy-azure.mjs", {
    ...bot,
    TEAMS_APP_ID: teamsAppId,
    TEAMS_APP_VERSION: teamsVersion,
    SKIP_BUILD: "1",
    IMAGE_TAG: "latest",
  });
}

if (steps.has("5")) {
  step("5. 生成并校验 Teams 应用包");
  const packageEnv = { ...bot, PUBLIC_URL: publicUrl, TEAMS_APP_ID: teamsAppId, TEAMS_APP_VERSION: teamsVersion, TEAMS_BOT_ID: bot.MICROSOFT_APP_ID };
  script("generate-icons.mjs", packageEnv);
  script("generate-manifest.mjs", packageEnv);
  runLive(process.execPath, [path.join(here, "pack-teams-app.mjs"), path.resolve(root, zipPath)], { env: { ...base, ...packageEnv } });
  const manifest = JSON.parse(fs.readFileSync(generatedManifest, "utf8"));
  if (manifest.webApplicationInfo?.resource !== `api://${new URL(publicUrl).hostname}/botid-${bot.MICROSOFT_APP_ID}`) {
    fail("manifest 的 Teams SSO resource 与预期 Application ID URI 不一致，拒绝输出错误应用包");
  }
  if (manifest.staticTabs?.[0]?.contentUrl !== `${publicUrl}/?inTeams=1`) {
    fail("manifest 的 Tab 地址与部署的 PUBLIC_URL 不一致，拒绝输出错误应用包");
  }
  info(`manifest id=${manifest.id} version=${manifest.version}，SSO/Tab 地址已校验`);
}

step("6. 线上 smoke 验收");
const health = JSON.parse(run("curl", ["-fsS", "--max-time", "30", `${publicUrl}/api/health`]));
const meta = JSON.parse(run("curl", ["-fsS", "--max-time", "30", `${publicUrl}/api/meta`]));
if (!health.ok) fail("健康检查返回 ok=false");
if (!meta.sso?.configured) fail("服务已启动但 OBO 未装配：检查 MICROSOFT_APP_* 与 MICROSOFT_APP_TENANT_ID");
info(`health=ok mode=${health.mode} · sso.configured=${meta.sso.configured}`);
const digest = createHash("sha256").update(fs.readFileSync(path.resolve(root, zipPath))).digest("hex");
const state = {
  tenantId: params.TARGET_TENANT_ID,
  subscription: params.AZ_SUBSCRIPTION,
  resourceGroup: rg,
  location: base.LOCATION,
  appName: params.APP_NAME,
  botName,
  botAppId: bot.MICROSOFT_APP_ID,
  teamsAppId,
  teamsAppVersion: teamsVersion,
  publicUrl,
  messagingEndpoint: `${publicUrl}/api/messages`,
  package: zipPath,
  packageSha256: digest,
  billingPolicyConfirmed: billingConfirmed,
  deployedAt: new Date().toISOString(),
};
const saved = saveState(state);

step("完成 — 仅剩目录上传与人工验收");
console.log(`
  Web UI       : ${publicUrl}
  Messaging    : ${publicUrl}/api/messages
  应用包        : ${zipPath}
  SHA-256      : ${digest}
  凭据          : ${botEnvFile}（权限 600，已忽略）
  部署状态      : ${saved}（无机密，可用于 STEPS 恢复）

  仍需人工：
  1) ${billingConfirmed ? "在门户确认 Work IQ API 计费策略确实已激活，并给用户分配 M365 Copilot license。" : "配置并激活 Work IQ API 的 Copilot Credits 计费策略，然后把 BILLING_POLICY_READY=1 写入参数文件。"}
  2) Teams 管理中心 → Teams 应用 → 管理应用 → 上传 ${zipPath}
  3) 在 Teams 中打开 Tab，确认身份 chip；bot 发 /whoami、/ask <问题>。

  恢复示例：
    STEPS=4,5 BILLING_POLICY_READY=1 node scripts/onboard-tenant.mjs ${envFileArg}
`);
