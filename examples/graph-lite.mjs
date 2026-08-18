#!/usr/bin/env node
/**
 * 极简第三方应用：用自己的 App Registration 直接调 Microsoft Graph（路径 B，零依赖）
 * Minimal third-party app calling Microsoft Graph with its OWN App Registration.
 *
 * 前置条件（对应之前讨论的权限问题）:
 *   1. 在 Entra 创建 App Registration（'Public client flows' 需允许设备码流）；
 *   2. 在该 App Registration 上添加 delegated 权限，例如:
 *        Mail.Read  Calendars.Read  People.Read  User.Read
 *      （敏感权限如 Mail.Read 需要管理员同意）;
 *   3. 不需要给 Work IQ 那个 Client 做任何事 —— 这条路径不经过 Work IQ。
 *
 * 用法:
 *   TENANT_ID=<租户id> CLIENT_ID=<app registration的Application(client) id> node examples/graph-lite.mjs
 *   SCOPES="Mail.Read Calendars.Read" TENANT_ID=xxx CLIENT_ID=yyy node examples/graph-lite.mjs
 */
const tenant = process.env.TENANT_ID;
const clientId = process.env.CLIENT_ID;
if (!tenant || !clientId) {
  console.error("缺少环境变量: TENANT_ID=<租户id> CLIENT_ID=<app的Application(client) id>");
  process.exit(2);
}
const scopes = (process.env.SCOPES ?? "Mail.Read Calendars.Read People.Read").split(" ").map((s) => s.trim()).filter(Boolean);
const authority = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;

// ---------- 1. 请求设备码 ----------
const dcRes = await fetch(`${authority}/devicecode`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: clientId, scope: scopes.join(" ") }),
});
const dc = await dcRes.json();
if (!dc.device_code) {
  console.error("获取设备码失败:", JSON.stringify(dc));
  process.exit(1);
}
console.log(`\n请在浏览器打开 ${dc.verification_uri} 并输入代码: ${dc.user_code}\n`);

// ---------- 2. 轮询令牌 ----------
let token = null;
for (let attempt = 0; attempt < 120; attempt++) {
  await new Promise((r) => setTimeout(r, (dc.interval || 5) * 1000));
  const res = await fetch(`${authority}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: dc.device_code,
    }),
  });
  const body = await res.json();
  if (body.access_token) { token = body.access_token; break; }
  if (body.error === "authorization_pending") continue;
  console.error("认证失败:", body.error_description ?? body.error);
  process.exit(1);
}
if (!token) { console.error("等待授权超时"); process.exit(1); }

// ---------- 3. 用 token 调 Graph ----------
const graph = async (path) => {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GET ${path} -> ${res.status}: ${err.slice(0, 300)}`);
  }
  return res.json();
};

try {
  const me = await graph("/me?$select=displayName,mail,userPrincipalName");
  console.log("已登录为:", me.displayName, "<" + (me.mail ?? me.userPrincipalName) + ">");

  if (scopes.includes("Mail.Read")) {
    const msgs = await graph("/me/messages?$top=5&$select=subject,from,receivedDateTime");
    console.log("\n最新邮件:");
    for (const m of msgs.value ?? []) {
      console.log(`  - ${m.subject}  (${m.from?.emailAddress?.address ?? "?"})`);
    }
  }
  if (scopes.includes("Calendars.Read")) {
    const evts = await graph("/me/events?$top=5&$select=subject,start");
    console.log("\n最近的日历事件:");
    for (const e of evts.value ?? []) {
      console.log(`  - ${e.subject}  @ ${e.start?.dateTime ?? "?"}`);
    }
  }
} catch (e) {
  console.error("Graph 调用失败:", e.message);
  console.error("提示: 检查该 App Registration 是否配置了对应 delegated 权限，敏感权限需要管理员同意。");
  process.exit(1);
}
