#!/usr/bin/env node
/**
 * 直接探测 Work IQ 的 hosted MCP 端点（不经过 Teams），用来验证：
 *   1. 租户是否已启用 Work IQ、当前用户是否有 Copilot license
 *   2. 我们的 HttpMcpClient 与该端点的协议是否兼容
 *
 * 用设备码登录（device code）拿一个委托令牌，然后 initialize / tools/list / ask。
 *
 * 用法：
 *   npm run build                       # 需要 dist/workiq/http-mcp-client.js
 *   TENANT_ID=<tenantId> node scripts/probe-mcp.mjs "What meetings do I have this week?"
 *
 * 可选环境变量：
 *   CLIENT_ID   默认 Work IQ CLI 的公开客户端（ba081686-…），它支持 device code。
 *               想验证“自己的 App Registration 能不能拿到 WorkIQAgent.Ask”时传自己的 appId，
 *               但机密客户端默认不允许 device code，需要先：
 *                 az ad app update --id <appId> --set isFallbackPublicClient=true
 *               验证完记得改回 false（生产走的是 OBO，不需要公开客户端）。
 *   SCOPE       默认 fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask
 *   MCP_URL     默认 https://workiq.svc.cloud.microsoft/mcp
 */
import { HttpMcpClient } from "../dist/workiq/http-mcp-client.js";

const tenantId = process.env.TENANT_ID ?? "organizations";
const clientId = process.env.CLIENT_ID ?? "ba081686-5d24-4bc6-a0d6-d034ecffed87";
const scope = process.env.SCOPE ?? "fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask";
const mcpUrl = process.env.MCP_URL ?? "https://workiq.svc.cloud.microsoft/mcp";
const question = process.argv[2] ?? "What meetings do I have this week?";
const authBase = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0`;

const form = (data) => new URLSearchParams(data).toString();

console.log(`租户 ${tenantId} · 客户端 ${clientId}\nscope ${scope}\n端点 ${mcpUrl}\n`);

const startRes = await fetch(`${authBase}/devicecode`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: form({ client_id: clientId, scope: `${scope} offline_access` }),
});
const start = await startRes.json();
if (!start.device_code) {
  console.error("发起设备码登录失败:", start.error, "-", start.error_description);
  process.exit(1);
}
console.log("请在浏览器完成登录：");
console.log(`  ${start.verification_uri}`);
console.log(`  代码: ${start.user_code}\n`);

const deadline = Date.now() + (start.expires_in ?? 900) * 1000;
let token;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, (start.interval ?? 5) * 1000));
  const res = await fetch(`${authBase}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: start.device_code }),
  });
  const body = await res.json();
  if (body.access_token) {
    token = body.access_token;
    break;
  }
  if (body.error === "authorization_pending") {
    process.stdout.write(".");
    continue;
  }
  console.error("\n登录失败:", body.error, "-", body.error_description);
  process.exit(1);
}
if (!token) {
  console.error("\n设备码已过期");
  process.exit(1);
}

const claims = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
console.log(`\n\n已登录: ${claims.upn ?? claims.preferred_username ?? claims.oid}`);
console.log(`token aud=${claims.aud} appid=${claims.appid ?? claims.azp} scp=${claims.scp}\n`);

const client = new HttpMcpClient({ url: mcpUrl, accessToken: token, requestTimeoutMs: 180000, onLog: (l) => console.debug("[mcp]", l) });
try {
  const tools = await client.listTools();
  console.log(`tools/list → ${tools.length} 个工具: ${tools.map((t) => t.name).join(", ")}\n`);

  console.log(`ask: ${question}`);
  const started = Date.now();
  const result = await client.callTool("ask", { question });
  console.log(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log((result.content?.[0]?.text ?? "").slice(0, 1200));
} catch (e) {
  console.error("\n调用失败:", e?.code ?? "", e?.message ?? e);
  if (e?.hint) console.error("提示:", e.hint);
  process.exitCode = 1;
} finally {
  await client.close();
}
