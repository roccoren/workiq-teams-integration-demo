// Per-user Work IQ engine — hosted MCP endpoint over HTTP, authenticated with the
// caller's own delegated access token (Teams SSO → On-Behalf-Of). One instance serves
// exactly one identity, so it is built per request and closed when the request ends.
import { HttpMcpClient } from "./http-mcp-client.js";
import { askViaMcp, fetchBlobViaMcp, retrieveViaMcp, searchPathsViaMcp, type BlobResult, type PathEntry, type RetrieveResult } from "./tools.js";
import type { WorkIQEngine } from "./engine.js";
import { AskError, type AskResult, type EngineInfo, type EngineMode } from "./types.js";

export interface OboEngineOptions {
  url: string;
  accessToken: string;
  timeoutMs: number;
  onLog?: (line: string) => void;
}

export class OboEngine implements WorkIQEngine {
  readonly mode: EngineMode = "live";
  private client: HttpMcpClient;
  private lastError: Error | null = null;

  constructor(private opts: OboEngineOptions) {
    this.client = new HttpMcpClient({
      url: opts.url,
      accessToken: opts.accessToken,
      requestTimeoutMs: opts.timeoutMs,
      onLog: opts.onLog,
    });
  }

  get info(): EngineInfo {
    return {
      mode: "live",
      label: "Work IQ (live, hosted MCP)",
      detail: `MCP endpoint: ${this.opts.url} · transport: http · delegated user token`,
      degraded: !!this.lastError,
      degradedReason: this.lastError?.message,
    };
  }

  /** Boot probe: the handshake plus a tools listing. Auth failures surface unchanged. */
  async health(): Promise<void> {
    try {
      await this.client.listTools(true);
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e : new Error(String(e));
      throw this.translate(e);
    }
  }

  // The `account` option is ignored on every method below: the hosted endpoint derives
  // identity from the bearer token, so there is no account to select.
  async ask(question: string, opts?: { conversationId?: string; account?: string; signal?: AbortSignal }): Promise<AskResult> {
    try {
      return await askViaMcp(this.client, question, { conversationId: opts?.conversationId, timeoutMs: this.opts.timeoutMs });
    } catch (e) {
      throw this.translate(e);
    }
  }

  async retrieve(queries: string[], opts?: { strategy?: "copilot" | "grounding"; account?: string }): Promise<RetrieveResult> {
    try {
      return await retrieveViaMcp(this.client, queries, { strategy: opts?.strategy, timeoutMs: this.opts.timeoutMs });
    } catch (e) {
      throw this.translate(e);
    }
  }

  async fetchBlob(path: string): Promise<BlobResult> {
    try {
      return await fetchBlobViaMcp(this.client, path, this.opts.timeoutMs);
    } catch (e) {
      throw this.translate(e);
    }
  }

  async searchPaths(filter: string): Promise<PathEntry[]> {
    try {
      return await searchPathsViaMcp(this.client, filter, this.opts.timeoutMs);
    } catch (e) {
      throw this.translate(e);
    }
  }

  /**
   * Accepts the Work IQ EULA for the signed-in user. Work IQ refuses queries (403 /
   * EULA errors) until this ran once per identity; it is deliberately an explicit
   * action, never automatic, because the user is the one accepting the terms.
   */
  async acceptEula(): Promise<string> {
    try {
      const res = await this.client.callTool("accept_eula", {}, this.opts.timeoutMs);
      return res.content?.[0]?.text ?? "accepted";
    } catch (e) {
      throw this.translate(e);
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** HttpMcpClient already yields AskError; anything else (parser bugs) becomes ENGINE_ERROR. */
  private translate(e: unknown): AskError {
    if (e instanceof AskError) return e;
    return new AskError("ENGINE_ERROR", e instanceof Error ? e.message : String(e), `Endpoint: ${this.opts.url}`);
  }
}
