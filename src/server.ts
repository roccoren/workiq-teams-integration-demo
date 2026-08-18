// WorkIQ Query & Use Demo — server entry point.
// Boots: config -> engine (live Work IQ over MCP, or mock) -> REST/SSE API -> Teams bot -> static UI.
import "dotenv/config";
import { loadConfig, type AppConfig } from "./config.js";
import { createEngine, type WorkIQEngine } from "./workiq/engine.js";
import { RemoteEngine } from "./workiq/remote-engine.js";
import { OboEngine } from "./workiq/obo-engine.js";
import { OboTokenService, type OboIdentity } from "./auth/obo.js";
import { createApp } from "./api/routes.js";
import { registerTeamsBot } from "./api/teams-bot.js";
import { AccountRegistry } from "./workiq/accounts.js";
import type { Server } from "node:http";

export interface BootResult {
  server: Server;
  engine: WorkIQEngine;
  config: AppConfig;
  resolvedMode: "live" | "mock";
  warnings: string[];
  port: number;
  accounts: AccountRegistry;
}

export async function startServer(config: AppConfig): Promise<BootResult> {
  const accounts = new AccountRegistry(process.env.WORKIQ_ACCOUNTS, process.env.ACCOUNT_MAP_FILE);

  // Teams SSO -> On-Behalf-Of: each request may carry the caller's own token, which we
  // exchange for a delegated Work IQ token and use against the hosted MCP endpoint.
  const obo = config.aad ? new OboTokenService({ ...config.aad, scope: config.workiqScope }) : undefined;
  const oboEngineFor = obo
    ? (identity: OboIdentity): WorkIQEngine =>
        new OboEngine({
          url: config.workiqMcpUrl,
          accessToken: identity.token,
          timeoutMs: config.timeoutMs,
          onLog: (line) => console.debug("[workiq-obo]", line.trimEnd()),
        })
    : undefined;
  console.log(
    obo
      ? `[obo] armed — ${config.workiqMcpUrl} as the signed-in user (scope ${config.workiqScope})`
      : "[obo] disabled — set MICROSOFT_APP_ID / MICROSOFT_APP_PASSWORD / MICROSOFT_APP_TENANT_ID (or AAD_CLIENT_ID / AAD_CLIENT_SECRET / AAD_TENANT_ID) to enable per-user Work IQ access",
  );

  // Remote-engine mode: this server is only a UI/bot frontend; the Work IQ MCP
  // processes (and per-user token caches) live on the ENGINE_API_URL host.
  if (config.engineApiUrl) {
    const remote = new RemoteEngine(config.engineApiUrl);
    try {
      await remote.health();
      console.log(`[engine] remote mode: ${config.engineApiUrl} (mode=${remote.info.mode})`);
    } catch (e) {
      console.warn(`[engine] remote health check failed: ${e instanceof Error ? e.message : e}`);
    }
    const app = createApp({ engine: remote, config, warnings: [], accounts, getEngine: () => remote, obo, oboEngineFor });
    const bot = registerTeamsBot(app, () => remote, config, accounts);
    if (bot) console.log("[teams-bot] enabled — POST /api/messages");
    const server = app.listen(config.port);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    return { server, engine: remote, config, resolvedMode: remote.info.mode, warnings: [], port, accounts };
  }

  const { engine, resolvedMode, warnings } = await createEngine(config, (line) => console.debug("[workiq-mcp]", line.trimEnd()));

  const app = createApp({
    engine,
    config,
    warnings,
    accounts,
    getEngine: () => engine,
    obo,
    oboEngineFor,
  });

  const bot = registerTeamsBot(app, () => engine, config, accounts);
  if (bot) console.log("[teams-bot] enabled — POST /api/messages");

  const server = app.listen(config.port);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  return { server, engine, config, resolvedMode, warnings, port, accounts };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, engine, resolvedMode, warnings, port, accounts } = await startServer(config);
  console.log("");
  console.log("┌──────────────────────────────────────────────────────────────┐");
  console.log("│  WorkIQ Query & Use Demo                                      │");
  console.log("└──────────────────────────────────────────────────────────────┘");
  console.log("");
  console.log(`  Web UI     : http://localhost:${port}`);
  console.log(`  Health     : http://localhost:${port}/api/health`);
  console.log(`  Engine     : ${resolvedMode} (${engine.info.label})`);
  if (engine.info.account) console.log(`  Account    : ${engine.info.account} (default)`);
  if (accounts.list.length > 1) console.log(`  Accounts   : ${accounts.list.join(", ")}`);
  for (const w of warnings) console.warn(`  Warning    : ${w}`);
  console.log("  Teams bot  : " + (config.bot.appId && config.bot.appPassword ? "enabled (POST /api/messages)" : "disabled (set MICROSOFT_APP_ID / MICROSOFT_APP_PASSWORD to enable)"));
  console.log("");

  const shutdown = async (sig: string) => {
    console.log(`
${sig} received, shutting down…`);
    server.close();
    await engine.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ""))) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}