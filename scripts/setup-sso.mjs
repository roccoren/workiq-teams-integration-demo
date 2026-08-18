#!/usr/bin/env node
/**
 * 配置 Teams SSO + On-Behalf-Of（OBO）所需的 Entra / Azure Bot 设置。
 *
 * 做的事（全部幂等）：
 *   1. 确保 Work IQ 首方服务主体（Work IQ API + Work IQ CLI）已在租户里 provision
 *   2. 给你的 App Registration 配置：
 *        - requestedAccessTokenVersion = 2
 *        - Application ID URI = api://<PUBLIC_URL 主机名>/botid-<appId>
 *        - 暴露 scope access_as_user
 *        - 预授权 Teams / M365 / Outlook 客户端
 *        - 申请 Work IQ 的委托权限 WorkIQAgent.Ask
 *   3. 确保你的应用在本租户有服务主体（授予同意的前提）
 *   4. CONSENT=1 时直接执行管理员同意；否则打印同意 URL
 *   5. 提供 BOT_NAME 时创建/更新 Azure Bot 的 OAuth 连接（bot 侧 SSO 用）
 *
 * 用法：
 *   APP_ID=<botAppId> APP_SECRET=<secret> PUBLIC_URL=https://<host> \
 *   TENANT_ID=<tenantId> [CONSENT=1] [BOT_NAME=<app-name>-bot BOT_RESOURCE_GROUP=<app-name>-rg] \
 *   node scripts/setup-sso.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const step = (msg) => console.log("\n==> " + msg);
const fail = (msg) => { console.error("\n✗ " + msg); process.exit(2); };
const sh = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
  } catch (e) {
    const detail = (e.stderr || e.stdout || e.message || "").toString().trim();
    throw new Error(`${cmd} ${args.join(" ")}\n${detail}`);
  }
};

// Work IQ 首方应用（从 https://workiq.svc.cloud.microsoft/.well-known/oauth-protected-resource/mcp 得到）
const WORKIQ_API_APP_ID = process.env.WORKIQ_API_APP_ID ?? "fdcc1f02-fc51-4226-8753-f668596af7f7";
const WORKIQ_ASK_SCOPE_ID = process.env.WORKIQ_ASK_SCOPE_ID ?? "0b1715fd-f4bf-4c63-b16d-5be31f9847c2"; // WorkIQAgent.Ask
const WORKIQ_CLI_APP_ID = "ba081686-5d24-4bc6-a0d6-d034ecffed87";
const WORKIQ_SCOPE = process.env.WORKIQ_SCOPE ?? `${WORKIQ_API_APP_ID}/WorkIQAgent.Ask`;

// Teams / M365 / Outlook 客户端 —— 预授权后用户在 Teams 里无需再次同意
// https://learn.microsoft.com/microsoftteams/platform/tabs/how-to/authentication/tab-sso-register-aad
const M365_CLIENTS = {
  "Teams desktop/mobile": "1fec8e78-bce4-4aaf-ab1b-5451cc387264",
  "Teams web": "5e3ce6c0-2b1f-4285-8d4b-75ee78787346",
  "Microsoft 365 web": "4765445b-32c6-49b0-83e6-1d93765276ca",
  "Microsoft 365 desktop": "0ec893e0-5785-4de6-99da-4ed124e5296c",
  "Microsoft 365 mobile / Outlook desktop": "d3590ed6-52b3-4102-aeff-aad2292ab01c",
  "Outlook web": "bc59ab01-8403-45c6-8796-ac3ef710b3e3",
  "Outlook mobile": "27922004-5251-4030-b22d-91ecd9a37ea4",
};

const appId = process.env.APP_ID ?? process.env.MICROSOFT_APP_ID;
const appSecret = process.env.APP_SECRET ?? process.env.MICROSOFT_APP_PASSWORD;
const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
const consent = process.env.CONSENT === "1";
const botName = process.env.BOT_NAME ?? "";
const botRg = process.env.BOT_RESOURCE_GROUP ?? "";
const connectionName = process.env.OAUTH_CONNECTION_NAME ?? "workiq";

if (!appId) fail("缺少 APP_ID（或 MICROSOFT_APP_ID）");
if (!publicUrl) fail("缺少 PUBLIC_URL（部署后的外部 https 地址）");
let publicHost;
try {
  publicHost = new URL(publicUrl).hostname;
} catch {
  fail(`PUBLIC_URL 不是合法 URL: ${publicUrl}`);
}

step("0. 检查 az 登录");
const who = JSON.parse(sh("az", ["account", "show", "--query", "{tenant:tenantId,user:user.name}", "-o", "json"]));
const tenantId = process.env.TENANT_ID ?? who.tenant;
console.log("身份:", who.user, "| 租户:", tenantId);

step("1. 确保 Work IQ 首方服务主体存在");
for (const [label, id] of [["Work IQ API", WORKIQ_API_APP_ID], ["Work IQ CLI", WORKIQ_CLI_APP_ID]]) {
  try {
    const sp = JSON.parse(sh("az", ["ad", "sp", "show", "--id", id, "--query", "{displayName:displayName}", "-o", "json"]));
    console.log(`  已存在: ${label} (${sp.displayName})`);
  } catch {
    sh("az", ["ad", "sp", "create", "--id", id, "-o", "none"]);
    console.log(`  已创建: ${label}`);
  }
}

step("2. 读取现有 App Registration");
const app = JSON.parse(sh("az", ["ad", "app", "show", "--id", appId, "-o", "json"]));
const objectId = app.id;
const identifierUri = `api://${publicHost}/botid-${appId}`;
// 复用已有的 access_as_user scope id，避免每次重跑都换 GUID（换了会让已同意的客户端失效）
const existingScope = (app.api?.oauth2PermissionScopes ?? []).find((s) => s.value === "access_as_user");
const scopeId = existingScope?.id ?? randomUUID();
console.log("  objectId:", objectId);
console.log("  Application ID URI:", identifierUri);
console.log("  access_as_user scope id:", scopeId, existingScope ? "(复用)" : "(新建)");

step("3. 写入 API 配置（token v2 + identifierUri + scope + 预授权客户端）");
const apiBody = {
  identifierUris: [identifierUri],
  api: {
    requestedAccessTokenVersion: 2,
    oauth2PermissionScopes: [
      {
        id: scopeId,
        value: "access_as_user",
        type: "User",
        isEnabled: true,
        adminConsentDisplayName: "Access the WorkIQ assistant as you",
        adminConsentDescription: "Allows Teams to call the WorkIQ assistant API on behalf of the signed-in user.",
        userConsentDisplayName: "Access the WorkIQ assistant as you",
        userConsentDescription: "Allows Teams to call the WorkIQ assistant API on your behalf.",
      },
    ],
  },
  requiredResourceAccess: [
    { resourceAppId: WORKIQ_API_APP_ID, resourceAccess: [{ id: WORKIQ_ASK_SCOPE_ID, type: "Scope" }] },
  ],
};
// Graph 拒绝“同一次 PATCH 里既新建 scope 又引用它”，所以分两趟：先建 scope，再预授权客户端。
const patchApp = (body) => {
  const bodyFile = path.join(os.tmpdir(), `sso-app-${appId}-${randomUUID()}.json`);
  fs.writeFileSync(bodyFile, JSON.stringify(body));
  try {
    sh("az", ["rest", "--method", "PATCH", "--url", `https://graph.microsoft.com/v1.0/applications/${objectId}`,
      "--headers", "Content-Type=application/json", "--body", `@${bodyFile}`]);
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
};
patchApp(apiBody);
patchApp({
  api: {
    preAuthorizedApplications: Object.values(M365_CLIENTS).map((clientAppId) => ({
      appId: clientAppId,
      delegatedPermissionIds: [scopeId],
    })),
  },
});
console.log("  已写入。预授权客户端:", Object.keys(M365_CLIENTS).join(" · "));

step("4. 确保应用在本租户有服务主体");
try {
  sh("az", ["ad", "sp", "show", "--id", appId, "-o", "none"]);
  console.log("  已存在");
} catch {
  sh("az", ["ad", "sp", "create", "--id", appId, "-o", "none"]);
  console.log("  已创建");
}

step("5. 管理员同意 WorkIQAgent.Ask");
const consentUrl = `https://login.microsoftonline.com/${tenantId}/adminconsent?client_id=${appId}`;
const clientSpId = JSON.parse(sh("az", ["ad", "sp", "show", "--id", appId, "--query", "{id:id}", "-o", "json"])).id;
const workiqSpId = JSON.parse(sh("az", ["ad", "sp", "show", "--id", WORKIQ_API_APP_ID, "--query", "{id:id}", "-o", "json"])).id;
const listGrants = () => JSON.parse(sh("az", ["rest", "--method", "GET", "--url",
  `https://graph.microsoft.com/v1.0/oauth2PermissionGrants?$filter=clientId eq '${clientSpId}'`, "-o", "json"])).value ?? [];
let grant = listGrants().find((g) => g.resourceId === workiqSpId);
if (consent) {
  // `az ad app permission admin-consent` 走的是旧门户接口，服务主体刚创建时会报
  // "service principal name is already present"；直接写 oauth2PermissionGrants 更可靠。
  const scopes = new Set((grant?.scope ?? "").split(" ").filter(Boolean));
  scopes.add("WorkIQAgent.Ask");
  const body = { clientId: clientSpId, consentType: "AllPrincipals", resourceId: workiqSpId, scope: [...scopes].join(" ") };
  const grantFile = path.join(os.tmpdir(), `sso-grant-${randomUUID()}.json`);
  fs.writeFileSync(grantFile, JSON.stringify(grant ? { scope: body.scope } : body));
  try {
    if (grant) {
      sh("az", ["rest", "--method", "PATCH", "--url", `https://graph.microsoft.com/v1.0/oauth2PermissionGrants/${grant.id}`,
        "--headers", "Content-Type=application/json", "--body", `@${grantFile}`]);
    } else {
      sh("az", ["rest", "--method", "POST", "--url", "https://graph.microsoft.com/v1.0/oauth2PermissionGrants",
        "--headers", "Content-Type=application/json", "--body", `@${grantFile}`, "-o", "none"]);
    }
    console.log("  已授予（AllPrincipals，全租户生效）");
  } catch (e) {
    console.log(`  自动授予失败，请用浏览器打开：\n     ${consentUrl}\n     ${String(e.message).split("\n").slice(-1)[0]}`);
  } finally {
    fs.rmSync(grantFile, { force: true });
  }
} else {
  console.log(`  跳过（CONSENT=1 可自动执行）。浏览器同意 URL：\n     ${consentUrl}`);
}

step("6. 验证同意结果");
grant = listGrants().find((g) => g.resourceId === workiqSpId);
const grantOk = Boolean(grant && grant.scope?.includes("WorkIQAgent.Ask"));
console.log(grantOk ? `  ✓ 已授予: ${grant.scope} (consentType=${grant.consentType})` : "  ✗ 尚未看到 WorkIQAgent.Ask 的授权");

if (botName) {
  step("7. 配置 Azure Bot 的 OAuth 连接（bot 侧 SSO）");
  if (!appSecret) fail("配置 OAuth 连接需要 APP_SECRET（或 MICROSOFT_APP_PASSWORD）");
  if (!botRg) fail("配置 OAuth 连接需要 BOT_RESOURCE_GROUP");
  // 密码可能以 "-" 开头，必须用 --flag=value 形式，否则 argparse 认成新参数
  const args = ["bot", "authsetting", "create", "-n", botName, "-g", botRg, "-c", connectionName,
    `--client-id=${appId}`, `--client-secret=${appSecret}`, "--service", "Aadv2",
    `--provider-scope-string=${WORKIQ_SCOPE}`,
    "--parameters", `tenantId=${tenantId}`, `tokenExchangeUrl=${identifierUri}`, "-o", "none"];
  try {
    sh("az", args);
    console.log(`  已创建连接 "${connectionName}"`);
  } catch (e) {
    const msg = String(e.message);
    if (/already exists|Conflict/i.test(msg)) {
      sh("az", ["bot", "authsetting", "delete", "-n", botName, "-g", botRg, "-c", connectionName, "-o", "none"]);
      sh("az", args);
      console.log(`  已重建连接 "${connectionName}"`);
    } else {
      throw e;
    }
  }
}

step("完成 — 下一步");
console.log(`
  Application ID URI : ${identifierUri}
  access_as_user     : ${scopeId}
  Work IQ 权限       : ${WORKIQ_SCOPE} (${grantOk ? "已同意" : "待同意"})
  ${botName ? `Bot OAuth 连接     : ${connectionName}（把 OAUTH_CONNECTION_NAME=${connectionName} 配到服务上）` : "未配置 Bot OAuth 连接（给 BOT_NAME/BOT_RESOURCE_GROUP 即可）"}

  1) 重新生成并上传 Teams 应用包（manifest 需要 webApplicationInfo）:
       PUBLIC_URL=${publicUrl} TEAMS_BOT_ID=${appId} node scripts/generate-manifest.mjs
  2) 服务端环境变量:
       MICROSOFT_APP_ID / MICROSOFT_APP_PASSWORD / MICROSOFT_APP_TENANT_ID=${tenantId}
       WORKIQ_SCOPE=${WORKIQ_SCOPE}${botName ? `\n       OAUTH_CONNECTION_NAME=${connectionName}` : ""}
  3) 每个使用者仍需 Microsoft 365 Copilot license，租户需已完成 Work IQ 启用。
`);
