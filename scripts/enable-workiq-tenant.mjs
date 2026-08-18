#!/usr/bin/env node
/**
 * 在租户里启用 Work IQ（等价于官方 Enable-WorkIQToolsForTenant.ps1，但只用 az CLI，不需要 PowerShell）。
 *
 * 解决的问题：
 *   - 一键同意 URL 报 AADSTS650052 / Access Denied —— 租户里缺 Work IQ MCP Server 的服务主体；
 *   - 同意页面点完跳到 http://localhost 打不开 —— 那是 Work IQ CLI 这个公开客户端的注册回调地址，
 *     浏览器打不开不代表失败也不代表成功，得回读 oauth2PermissionGrants 才算数。
 *
 * 做的事（全部幂等）：
 *   1. provision 10 个 MCP Server 服务主体 + Work IQ CLI 服务主体
 *   2. 给 Work IQ CLI 授予 7 个 Microsoft Graph 委托权限（AllPrincipals）
 *   3. 给 Work IQ CLI 授予各 MCP Server 的委托权限
 *   4. 回读全部授权做验证
 *
 * 用法：
 *   az login --tenant <tenantId>          # 需要 Global / Cloud App / Application Admin
 *   node scripts/enable-workiq-tenant.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const step = (msg) => console.log("\n==> " + msg);
const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const detail = (e.stderr || e.stdout || e.message || "").toString().trim();
    throw new Error(`${cmd} ${args.join(" ")}\n${detail}`);
  }
};

const WORKIQ_CLI_APP_ID = "ba081686-5d24-4bc6-a0d6-d034ecffed87";
const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
const GRAPH_SCOPES = "Sites.Read.All Mail.Read People.Read.All OnlineMeetingTranscript.Read.All Chat.Read ChannelMessage.Read.All ExternalItem.Read.All";
const WORKIQ_TOOLS_APP_ID = "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1";
// Work IQ Tools 的 scope 在 SP 上查不全，官方脚本给的是这份显式清单
const WORKIQ_TOOLS_SCOPES = "McpServers.CopilotMCP.All McpServers.Me.All McpServers.Mail.All McpServers.Calendar.All McpServers.Teams.All McpServers.Word.All McpServers.OneDriveSharepoint.All McpServers.SharepointLists.All McpServers.SharePoint.All McpServers.OneDrive.All McpServers.Dataverse.All McpServers.M365Admin.All McpServers.Management.All";
const MCP_SERVERS = [
  { name: "Work IQ Tools", appId: WORKIQ_TOOLS_APP_ID },
  { name: "mcp_MailTools", appId: "16b1878d-62c7-4009-aa25-68989d63bbad" },
  { name: "mcp_MeServer", appId: "147dc821-b413-44c0-8009-1a3098378012" },
  { name: "mcp_CalendarTools", appId: "910333d2-47e9-43ca-981f-6df2f4531ef4" },
  { name: "mcp_TeamsServer", appId: "ce5029ee-c1d3-45c0-bdcc-efb5a4245687" },
  { name: "mcp_OneDriveRemoteServer", appId: "b0b2a2bb-6361-4549-a00c-a018417eb8e2" },
  { name: "mcp_SharePointRemoteServer", appId: "292cff14-c0e8-4116-9e3b-99934ae05766" },
  { name: "mcp_AdminTools", appId: "2dbeefeb-6462-48a4-abe6-1c4989699319" },
  { name: "mcp_WordServer", appId: "c2d0c2b6-8013-4346-9f8b-b81d3b754a29" },
  { name: "mcp_M365Copilot", appId: "ab7c82de-7946-4454-ac28-70249d17c95e" },
];

const graphJson = (method, url, body) => {
  const args = ["rest", "--method", method, "--url", url];
  let file;
  if (body) {
    file = path.join(os.tmpdir(), `workiq-graph-${randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify(body));
    args.push("--headers", "Content-Type=application/json", "--body", `@${file}`);
  }
  try {
    const out = sh("az", args);
    return out ? JSON.parse(out) : null;
  } finally {
    if (file) fs.rmSync(file, { force: true });
  }
};

const ensureSp = (appId, label) => {
  try {
    const sp = graphJson("GET", `https://graph.microsoft.com/v1.0/servicePrincipals(appId='${appId}')`);
    console.log(`  已存在: ${label} (${sp.displayName})`);
    return sp;
  } catch {
    sh("az", ["ad", "sp", "create", "--id", appId, "-o", "none"]);
    const sp = graphJson("GET", `https://graph.microsoft.com/v1.0/servicePrincipals(appId='${appId}')`);
    console.log(`  已创建: ${label} (${sp.displayName})`);
    return sp;
  }
};

const sorted = (scopes) => scopes.split(" ").filter(Boolean).sort().join(" ");

const grant = (clientSpId, resourceSp, scopes, label) => {
  if (!scopes) {
    console.log(`  跳过 ${label}：没有可授予的委托权限`);
    return;
  }
  const existing = (graphJson("GET",
    `https://graph.microsoft.com/v1.0/oauth2PermissionGrants?$filter=clientId eq '${clientSpId}'`).value ?? [])
    .find((g) => g.resourceId === resourceSp.id);
  if (existing && sorted(existing.scope ?? "") === sorted(scopes)) {
    console.log(`  已授予 ${label}`);
    return;
  }
  if (existing) {
    graphJson("PATCH", `https://graph.microsoft.com/v1.0/oauth2PermissionGrants/${existing.id}`, { scope: scopes });
    console.log(`  已更新 ${label}`);
    return;
  }
  graphJson("POST", "https://graph.microsoft.com/v1.0/oauth2PermissionGrants", {
    clientId: clientSpId,
    consentType: "AllPrincipals",
    resourceId: resourceSp.id,
    scope: scopes,
  });
  console.log(`  已授予 ${label}`);
};

step("0. 检查 az 登录");
const who = JSON.parse(sh("az", ["account", "show", "--query", "{tenant:tenantId,user:user.name}", "-o", "json"]));
console.log("身份:", who.user, "| 租户:", who.tenant);

step("1. provision MCP Server 服务主体");
const serverSps = MCP_SERVERS.map((s) => ({ ...s, sp: ensureSp(s.appId, s.name) }));

step("2. provision Work IQ CLI 服务主体");
const cliSp = ensureSp(WORKIQ_CLI_APP_ID, "Work IQ CLI");

step("3. 授予 Microsoft Graph 委托权限");
const graphSp = graphJson("GET", `https://graph.microsoft.com/v1.0/servicePrincipals(appId='${GRAPH_APP_ID}')`);
grant(cliSp.id, graphSp, GRAPH_SCOPES, `Microsoft Graph (${GRAPH_SCOPES.split(" ").length} 个 scope)`);

step("4. 授予各 MCP Server 的委托权限");
for (const server of serverSps) {
  const scopes = server.appId === WORKIQ_TOOLS_APP_ID
    ? WORKIQ_TOOLS_SCOPES
    : (server.sp.oauth2PermissionScopes ?? []).map((s) => s.value).join(" ");
  grant(cliSp.id, server.sp, scopes, server.name);
}

step("5. 验证");
const grants = graphJson("GET",
  `https://graph.microsoft.com/v1.0/oauth2PermissionGrants?$filter=clientId eq '${cliSp.id}'`).value ?? [];
const byId = new Map([[graphSp.id, "Microsoft Graph"], ...serverSps.map((s) => [s.sp.id, s.name])]);
for (const g of grants) {
  console.log(`  ${(byId.get(g.resourceId) ?? g.resourceId).padEnd(28)} ${g.consentType}  ${g.scope}`);
}
console.log(`\n共 ${grants.length} 条授权。`);
console.log(`
下一步：
  - 用户端不需要再点任何同意；有 Microsoft 365 Copilot license 即可使用。
  - 验证（不经过 Teams）：TENANT_ID=${who.tenant} node scripts/probe-mcp.mjs "What meetings do I have this week?"
`);
