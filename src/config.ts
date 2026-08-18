import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/config.ts -> project root (one level up), dist/config.js -> project root (also one level up)
const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

export interface AppConfig {
  port: number;
  mode: "auto" | "live" | "mock";
  /** When set, the server acts as a pure frontend/bot: the engine runs remotely. */
  engineApiUrl?: string;
  /** Full CLI invocation (split on whitespace), e.g. "node ./cli/workiq.js" or "npx -y @microsoft/workiq". */
  cliCommand?: string;
  account?: string;
  timeoutMs: number;
  /** Simulated per-token delay when streaming answers (both modes). */
  streamChunkMs: number;
  /** External HTTPS base URL of this deployment (no trailing slash). Required for Teams tabs/dialogs. */
  publicUrl?: string;
  bot: { appId?: string; appPassword?: string; tenantId?: string };
  teamsApp: { id?: string; botId?: string; name: string };
  /** Hosted Work IQ MCP endpoint used with a per-user delegated (OBO) token. */
  workiqMcpUrl: string;
  /** Delegated scope requested for the user on that endpoint. */
  workiqScope: string;
  /** Entra app credentials for the On-Behalf-Of exchange; undefined when incomplete. */
  aad?: { tenantId: string; clientId: string; clientSecret: string };
  /** Bot Framework OAuth connection used for bot-side sign-in. */
  botOauthConnectionName?: string;
}

function bool(v: string | undefined, dflt = false): boolean {
  if (v === undefined) return dflt;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = (env.WORKIQ_MODE ?? "auto").toLowerCase();
  if (mode !== "auto" && mode !== "live" && mode !== "mock") {
    throw new Error(`WORKIQ_MODE must be auto|live|mock, got "${mode}"`);
  }
  // The bot registration doubles as the Entra app for Teams SSO; AAD_* overrides it.
  const tenantId = env.AAD_TENANT_ID || env.MICROSOFT_APP_TENANT_ID || "";
  const clientId = env.AAD_CLIENT_ID || env.MICROSOFT_APP_ID || "";
  const clientSecret = env.AAD_CLIENT_SECRET || env.MICROSOFT_APP_PASSWORD || "";
  return {
    port: Number(env.PORT ?? 3000),
    mode,
    engineApiUrl: env.ENGINE_API_URL || undefined,
    cliCommand: env.WORKIQ_CLI || undefined,
    account: env.WORKIQ_ACCOUNT || undefined,
    timeoutMs: Number(env.WORKIQ_TIMEOUT_MS ?? 180_000),
    streamChunkMs: Math.max(5, Number(env.WORKIQ_STREAM_CHUNK_MS ?? 24)),
    publicUrl: env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/, "") : undefined,
    bot: {
      appId: env.MICROSOFT_APP_ID || undefined,
      appPassword: env.MICROSOFT_APP_PASSWORD || undefined,
      tenantId: env.MICROSOFT_APP_TENANT_ID || undefined,
    },
    teamsApp: {
      id: env.TEAMS_APP_ID || undefined,
      botId: env.TEAMS_BOT_ID || undefined,
      name: env.TEAMS_APP_NAME || "WorkIQ Query Assistant",
    },
    workiqMcpUrl: env.WORKIQ_MCP_URL || "https://workiq.svc.cloud.microsoft/mcp",
    workiqScope: env.WORKIQ_SCOPE || "fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask",
    aad: tenantId && clientId && clientSecret ? { tenantId, clientId, clientSecret } : undefined,
    botOauthConnectionName: env.OAUTH_CONNECTION_NAME || undefined,
  };
}

export function envFileExists(): boolean {
  return fs.existsSync(path.join(ROOT, ".env"));
}