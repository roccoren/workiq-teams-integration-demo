// Dependency-free MCP client over the Streamable HTTP transport (spec rev 2025-06-18).
// Talks to the hosted Work IQ endpoint (https://workiq.svc.cloud.microsoft/mcp) with a
// per-user delegated access token, so every query runs under the caller's own identity.
// Responses arrive either as a single JSON body or as an SSE stream carrying one or more
// JSON-RPC frames; both are handled here.
import { AskError } from "./types.js";
import type { McpTool } from "./mcp-client.js";

export interface HttpMcpOptions {
  url: string;
  accessToken: string;
  requestTimeoutMs?: number;
  onLog?: (line: string) => void;
}

const PROTOCOLS = ["2025-06-18", "2024-11-05", "2024-10-07"];
const DEFAULT_TIMEOUT_MS = 180_000;
const CLIENT_INFO = { name: "workiq-teams-demo", version: "1.0.0" };

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Carries the HTTP status so the handshake can tell "bad protocol version" from "bad token". */
class HttpStatusError extends AskError {
  constructor(code: ConstructorParameters<typeof AskError>[0], message: string, hint: string, readonly status: number) {
    super(code, message, hint);
  }
}

export class HttpMcpClient {
  private sessionId: string | null = null;
  private protocolVersion = PROTOCOLS[0];
  private initialized: Promise<void> | null = null;
  private toolsCache: McpTool[] | null = null;
  private nextId = 0;

  constructor(private opts: HttpMcpOptions) {}

  async listTools(force = false): Promise<McpTool[]> {
    if (this.toolsCache && !force) return this.toolsCache;
    await this.ensure();
    const res = (await this.request("tools/list", {})) as { tools?: McpTool[] };
    this.toolsCache = res?.tools ?? [];
    return this.toolsCache;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ content: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }> {
    await this.ensure();
    const res = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as {
      content?: { type: string; text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    if (res?.isError) {
      const text = (res.content?.[0]?.text ?? "") || "unknown error";
      throw this.toolError(name, text);
    }
    return { content: res?.content ?? [], structuredContent: res?.structuredContent, isError: false };
  }

  /** Best-effort session teardown: the spec's DELETE is optional and servers may refuse it. */
  async close(): Promise<void> {
    const session = this.sessionId;
    this.initialized = null;
    this.toolsCache = null;
    this.sessionId = null;
    if (!session) return;
    try {
      await fetch(this.opts.url, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.opts.accessToken}`,
          "MCP-Protocol-Version": this.protocolVersion,
          "Mcp-Session-Id": session,
        },
        signal: AbortSignal.timeout(5_000),
      });
    } catch (e) {
      this.opts.onLog?.(`workiq mcp: session delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Handshake once per client; concurrent callers share the same in-flight promise. */
  private ensure(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.handshake().catch((e) => {
        this.initialized = null;
        throw e;
      });
    }
    return this.initialized;
  }

  private async handshake(): Promise<void> {
    let lastError: unknown = null;
    for (const proto of PROTOCOLS) {
      this.protocolVersion = proto;
      try {
        await this.request("initialize", {
          protocolVersion: proto,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        });
        lastError = null;
        break;
      } catch (e) {
        // The spec rejects an unsupported version either as a JSON-RPC error or,
        // on the HTTP transport, as a 400 on the MCP-Protocol-Version header.
        // Anything else (auth, throttling, network) will not improve with an older
        // protocol — fail fast.
        const retryable = e instanceof AskError && (e.code === "ENGINE_ERROR" || (e instanceof HttpStatusError && e.status === 400));
        if (!retryable) throw e;
        lastError = e;
        this.sessionId = null;
      }
    }
    if (lastError) throw lastError;
    await this.notify("notifications/initialized", {});
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.opts.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.protocolVersion,
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }

  private async post(body: unknown, timeoutMs?: number): Promise<Response> {
    const ms = timeoutMs ?? this.opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    let res: Response;
    try {
      res = await fetch(this.opts.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ms),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new AskError(
          "ENGINE_TIMEOUT",
          `Work IQ MCP request timed out after ${Math.round(ms / 1000)}s`,
          "The hosted endpoint took too long; retry, or raise WORKIQ_TIMEOUT_MS.",
        );
      }
      throw new AskError(
        "ENGINE_UNAVAILABLE",
        `Work IQ MCP request failed: ${e instanceof Error ? e.message : String(e)}`,
        `Check network egress to ${this.opts.url}.`,
      );
    }
    const issued = res.headers.get("mcp-session-id");
    if (issued) this.sessionId = issued;
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw this.httpError(res);
    }
    return res;
  }

  /** JSON-RPC notification: no id, no response body expected (202/204, or a tolerated 200). */
  private async notify(method: string, params: unknown): Promise<void> {
    const res = await this.post({ jsonrpc: "2.0", method, params }, 30_000);
    await res.body?.cancel().catch(() => undefined);
  }

  private async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = ++this.nextId;
    const res = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const message = contentType.includes("text/event-stream")
      ? await this.readSse(res, id, method)
      : ((await res.json()) as JsonRpcResponse);
    if (message.error) throw this.rpcError(method, message.error);
    return message.result;
  }

  /**
   * Read the SSE body until the frame answering `id` arrives. Server notifications and
   * progress frames on the same stream are ignored; the reader is always released.
   */
  private async readSse(res: Response, id: number, method: string): Promise<JsonRpcResponse> {
    const body = res.body;
    if (!body) throw new AskError("ENGINE_ERROR", `Work IQ MCP returned an empty stream for "${method}"`);
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        // Frames are separated by a blank line; keep the trailing partial in the buffer.
        let sep: number;
        while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2));
          const parsed = this.parseSseFrame(frame, id);
          if (parsed) return parsed;
        }
        if (done) {
          const parsed = buffer.trim() ? this.parseSseFrame(buffer, id) : null;
          if (parsed) return parsed;
          throw new AskError(
            "ENGINE_ERROR",
            `Work IQ MCP stream ended without a response to "${method}"`,
            "The hosted endpoint closed the SSE stream early; retry the request.",
          );
        }
      }
    } finally {
      reader.releaseLock();
      await body.cancel().catch(() => undefined);
    }
  }

  /** Returns the JSON-RPC message when this frame answers `id`, otherwise null. */
  private parseSseFrame(frame: string, id: number): JsonRpcResponse | null {
    const data: string[] = [];
    for (const raw of frame.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
    }
    if (!data.length) return null;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(data.join("\n")) as JsonRpcResponse;
    } catch {
      this.opts.onLog?.(`workiq mcp: unparsable SSE frame: ${data.join("\n").slice(0, 200)}`);
      return null;
    }
    return msg.id === id ? msg : null;
  }

  private httpError(res: Response): AskError {
    const requestId = res.headers.get("request-id") ?? res.headers.get("x-request-id");
    const suffix = requestId ? ` (request-id ${requestId})` : "";
    if (res.status === 401 || res.status === 403) {
      return new HttpStatusError(
        "WORKIQ_UNAUTHORIZED",
        `Work IQ rejected the access token (HTTP ${res.status})${suffix}`,
        "The delegated token needs the fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask scope (admin-only). Grant it at https://login.microsoftonline.com/<tenant>/adminconsent?client_id=<appId>.",
        res.status,
      );
    }
    return new HttpStatusError(
      "ENGINE_UNAVAILABLE",
      `Work IQ MCP endpoint returned HTTP ${res.status} ${res.statusText}${suffix}`,
      res.status === 429 ? "Work IQ is throttling this tenant; retry after a short backoff." : `Endpoint: ${this.opts.url}`,
      res.status,
    );
  }

  private rpcError(method: string, error: { code?: number; message?: string; data?: unknown }): AskError {
    const message = error.message ?? JSON.stringify(error).slice(0, 500);
    if (/eula/i.test(message)) {
      return new AskError("EULA_REQUIRED", `Work IQ EULA not accepted: ${message}`, "Call the Work IQ `accept_eula` tool once for this user.");
    }
    return new AskError("ENGINE_ERROR", `Work IQ MCP "${method}" failed: ${message}`);
  }

  private toolError(name: string, text: string): AskError {
    // Work IQ meters its data plane against Copilot Credits. Without an *activated*
    // spending policy covering "Work IQ API" every data-plane tool is refused even
    // though consent, licenses and the token are correct — control-plane tools
    // (search_paths, get_schema, list_agents) keep working, which is the giveaway.
    if (/not entitled|billing policy|ai credit/i.test(text)) {
      return new AskError(
        "WORKIQ_FORBIDDEN",
        `Work IQ refused the caller: ${text.slice(0, 400)}`,
        "The tenant needs an activated usage-based billing (Copilot Credits) policy covering the \"Work IQ API\" service, with this user assigned: admin.cloud.microsoft → Copilot → Cost management → Configuration. Also confirm the user has a Microsoft 365 Copilot license.",
      );
    }
    if (/eula/i.test(text)) {
      return new AskError("EULA_REQUIRED", `Work IQ EULA not accepted: ${text.slice(0, 400)}`, "Call the Work IQ `accept_eula` tool once for this user (the bot's `/eula` command).");
    }
    if (/\bforbidden\b|status:\s*403/i.test(text)) {
      return new AskError(
        "WORKIQ_FORBIDDEN",
        `Work IQ refused the request for this user (403): ${text.slice(0, 400)}`,
        "Usual causes, in order: no activated Copilot Credits spending policy covering \"Work IQ API\" (admin.cloud.microsoft → Copilot → Cost management), no Microsoft 365 Copilot license (check M365_COPILOT_* service plans), or the Work IQ EULA was never accepted (`/eula`).",
      );
    }
    return new AskError("ENGINE_ERROR", `Work IQ tool "${name}" failed: ${text.slice(0, 600)}`);
  }
}
