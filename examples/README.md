# examples — 极简实现（零依赖）

对应前面讨论的两条调用路径，每个文件都是一个完整的、可直接运行的最小实现。

## 路径 A：`examples/ask-workiq.mjs` — 第三方 app 调 Work IQ（推荐）

**不需要创建任何 App Registration。** 原理：app 只是 spawn 官方 Work IQ CLI 的 MCP server（stdio + JSON-RPC），认证由 CLI 自己完成（device code 登录一次，token 缓存本地）。

```bash
# 一次性准备（每台机器做一次）：
npx -y @microsoft/workiq accept-eula
npx -y @microsoft/workiq auth login

# 然后直接问：
node examples/ask-workiq.mjs "What meetings do I have this week?"

# 多轮对话（沿用 conversationId）：
node examples/ask-workiq.mjs "and what's on the agenda?" --conversation-id <上一条输出的id>

# 结构化输出（JSON，含 answer + conversationId + 原始响应）：
node examples/ask-workiq.mjs "Summarize emails from Sarah about the budget" --json

# 指定账号 / 指定 CLI 路径：
node examples/ask-workiq.mjs "..." --account you@contoso.com
WORKIQ_CLI="node /path/to/bin/workiq.js" node examples/ask-workiq.mjs "..."
```

涉及的权限（管理员侧，见 docs/LIVE-SETUP.md）：对 Work IQ CLI 应用（client_id `ba081686-5d24-4bc6-a0d6-d034ecffed87`）做一次 admin consent；CLI 声明了 `Mail.Read`、`Calendars.Read`、`Sites.Read.All`、`Chat.Read`、`People.Read.All` 等 delegated 权限及 Work IQ MCP 资源的 `McpServers.*.All` scopes。用户侧只需 `workiq auth login` 一次。

## 路径 B：`examples/graph-lite.mjs` — 自己的 App Registration 直调 Graph

**需要创建 App Registration** 并配置 delegated 权限（如 `Mail.Read`、`Calendars.Read`），敏感权限要管理员同意。这条路径**不经过 Work IQ**，读的是原始 M365 数据。

```bash
# 1. 在 Entra 创建 App Registration（允许 public client flows）
# 2. 添加 delegated 权限：Mail.Read / Calendars.Read / People.Read 等（按需）
# 3. 运行（device code 登录）：
TENANT_ID=<租户id> CLIENT_ID=<app的Application(client) id> node examples/graph-lite.mjs
SCOPES="Mail.Read Calendars.Read" TENANT_ID=xxx CLIENT_ID=yyy node examples/graph-lite.mjs
```

## 两个文件的区别（对应权限讨论）

| | 路径 A（ask-workiq.mjs） | 路径 B（graph-lite.mjs） |
|---|---|---|
| 语义层 | ✅ Work IQ（能回答“帮我总结”） | ❌ 原始 Graph 数据 |
| App Registration | 不需要 | 需要（新建） |
| 权限配置 | 管理员对 Work IQ 官方应用做 admin consent | 在自己的 App 上配 delegated scopes + 同意 |
| 认证 | `workiq auth login`（CLI 缓存 token） | 设备码流（本脚本实现） |
| 典型用途 | 企业知识问答 / 智能助理 | 直接读写 M365 数据的业务集成 |
