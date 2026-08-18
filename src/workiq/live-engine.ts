// Live Work IQ engine — talks to Microsoft Work IQ over MCP (stdio).
// Primary integration path: the Work IQ MCP server ("workiq mcp") exposes
//   retrieve   — grounded retrieval over M365 + connected sources (structured hits)
//   ask        — end-to-end Q&A with M365 Copilot (multi-turn via conversationId)
//   fetch_blob — download binary document content for "use" flows
//   search_paths / fetch / create / update / delete / do_action / call_function
// The tool-call semantics themselves live in ./tools.ts and are shared with the
// hosted HTTP transport (OboEngine); this file owns the CLI process pool.
import { McpClientPool } from "./pool.js";
import type { McpClient } from "./mcp-client.js";
import { AskError, type AskResult, type EngineInfo, type EngineMode } from "./types.js";
import { askViaMcp, fetchBlobViaMcp, retrieveViaMcp, searchPathsViaMcp } from "./tools.js";
import type { BlobResult, PathEntry, RetrieveResult } from "./tools.js";
import { ROOT } from "../config.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Result shapes moved to ./tools.ts; re-exported so existing importers keep working.
export type { BlobResult, PathEntry, RetrievalHit, RetrieveResult } from "./tools.js";

export interface LiveEngineOptions {
  cliCommand?: string;
  account?: string;
  requestTimeoutMs?: number;
  onLog?: (line: string) => void;
}

/**
 * Resolves how to invoke the Work IQ CLI. `@microsoft/workiq` is an *optional*
 * dependency (~146 MB of native binary) because the Teams SSO + OBO path talks to the
 * hosted HTTP endpoint instead — see docs/SSO-OBO.md. `installed` is false when only the
 * npx fallback is left, which would download the package on first use: fine on a laptop,
 * never what you want inside a container, so callers surface CLI_NOT_FOUND instead.
 */
export function resolveCliCommand(cliCommand?: string): { command: string[]; source: string; installed: boolean } {
  if (cliCommand?.trim()) return { command: cliCommand.trim().split(/\s+/), source: "WORKIQ_CLI", installed: true };
  const local = join(ROOT, "node_modules", ".bin", "workiq");
  if (existsSync(local)) return { command: [local], source: "local node_modules/.bin/workiq", installed: true };
  const pathDirs = (process.env.PATH ?? "").split(":");
  for (const dir of pathDirs) {
    const candidate = join(dir, "workiq");
    if (existsSync(candidate)) return { command: [candidate], source: `PATH (${candidate})`, installed: true };
  }
  return { command: ["npx", "-y", "@microsoft/workiq"], source: "npx -y @microsoft/workiq", installed: false };
}

export class LiveEngine {
  readonly mode: EngineMode = "live";
  private pool: McpClientPool;
  private lastError: Error | null = null;
  private lastErrorAt = 0;
  private readonly timeoutMs: number;
  cliSource: string;
  /** False when only the npx fallback is available, i.e. the CLI is not installed here. */
  private readonly cliInstalled: boolean;

  constructor(private opts: LiveEngineOptions = {}) {
    const { command, source, installed } = resolveCliCommand(opts.cliCommand);
    this.cliSource = source;
    this.cliInstalled = installed;
    this.timeoutMs = opts.requestTimeoutMs ?? 240_000;
    this.pool = new McpClientPool({
      command,
      account: opts.account,
      requestTimeoutMs: this.timeoutMs,
      onLog: opts.onLog,
    });
  }

  /** Guard for every entry point: spawning `npx` here would fetch ~146 MB at request time. */
  private assertCliPresent(): void {
    if (this.cliInstalled) return;
    throw new AskError(
      "CLI_NOT_FOUND",
      "The Work IQ CLI is not installed on this host.",
      "@microsoft/workiq is an optional dependency. Either install it (npm install @microsoft/workiq, or build the image with --build-arg INCLUDE_WORKIQ_CLI=true), point WORKIQ_CLI at an existing binary, or use the Teams SSO + OBO path which needs no CLI (docs/SSO-OBO.md).",
    );
  }

  /** Per-account MCP client (each account gets its own `workiq mcp --account <email>` process). */
  clientFor(account?: string): McpClient {
    return this.pool.get(account);
  }

  get poolSize(): number { return this.pool.size; }

  get info(): EngineInfo {
    return {
      mode: "live",
      label: "Work IQ (live, via MCP)",
      detail: `MCP server: ${this.cliSource}${this.opts.account ? ` · account ${this.opts.account}` : ""}`,
      account: this.opts.account,
      degraded: !!this.lastError,
      degradedReason: this.lastError ? this.lastError.message : undefined,
    };
  }

  /** Boot probe: must be able to list tools. Throws AskError with guidance. */
  async health(): Promise<void> {
    this.assertCliPresent();
    try {
      await this.pool.get().listTools(true);
      this.lastError = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.lastError = e instanceof Error ? e : new Error(msg);
      this.lastErrorAt = Date.now();
      const lower = msg.toLowerCase();
      if (lower.includes("eula")) {
        throw new AskError("EULA_REQUIRED", "Work IQ EULA not accepted.", "Run: workiq accept-eula");
      }
      if (lower.includes("login") || lower.includes("auth") || lower.includes("consent") || lower.includes("sign in")) {
        throw new AskError("AUTH_REQUIRED", "Work IQ is not authenticated.", "Run: workiq auth login");
      }
      throw new AskError("ENGINE_UNAVAILABLE", `Work IQ MCP unavailable: ${msg}`, "Check that the WorkIQ CLI is installed and authenticated (docs/LIVE-SETUP.md).");
    }
  }

  /** Primary query path: natural-language Q&A over internal information. */
  async ask(question: string, opts?: { conversationId?: string; account?: string; signal?: AbortSignal }): Promise<AskResult> {
    const account = opts?.account ?? this.opts.account;
    this.assertCliPresent();
    try {
      const result = await askViaMcp(this.pool.get(account), question, {
        conversationId: opts?.conversationId,
        timeoutMs: this.timeoutMs,
      });
      return { ...result, account };
    } catch (e) {
      throw this.translate(e);
    }
  }

  /** Grounded retrieval: structured hits (emails, files, meetings, chats, people) + grounding markdown. */
  async retrieve(queries: string[], opts?: { strategy?: "copilot" | "grounding"; account?: string; signal?: AbortSignal }): Promise<RetrieveResult> {
    this.assertCliPresent();
    try {
      return await retrieveViaMcp(this.pool.get(opts?.account ?? this.opts.account), queries, {
        strategy: opts?.strategy,
        timeoutMs: this.timeoutMs,
      });
    } catch (e) {
      throw this.translate(e);
    }
  }

  /** Use flow: download a document's binary content via its WorkIQ path. */
  async fetchBlob(path: string, account?: string): Promise<BlobResult> {
    this.assertCliPresent();
    try {
      return await fetchBlobViaMcp(this.pool.get(account ?? this.opts.account), path, this.timeoutMs);
    } catch (e) {
      throw this.translate(e);
    }
  }

  /** Use flow: discover WorkIQ entity paths by filter (e.g. "mail", "calendar", "messages"). */
  async searchPaths(filter: string, account?: string): Promise<PathEntry[]> {
    this.assertCliPresent();
    try {
      return await searchPathsViaMcp(this.pool.get(account ?? this.opts.account), filter, this.timeoutMs);
    } catch (e) {
      throw this.translate(e);
    }
  }

  private translate(e: unknown): unknown {
    if (e instanceof AskError) return e;
    const msg = e instanceof Error ? e.message : String(e);
    const lower = msg.toLowerCase();
    if (lower.includes("eula")) return new AskError("EULA_REQUIRED", msg, "Run: workiq accept-eula");
    if (lower.includes("login") || lower.includes("auth") || lower.includes("consent")) return new AskError("AUTH_REQUIRED", msg, "Run: workiq auth login");
    if (lower.includes("timeout")) return new AskError("TIMEOUT", msg);
    return new AskError("LIVE_ERROR", msg);
  }

  async close(): Promise<void> {
    await this.pool.closeAll();
  }
}