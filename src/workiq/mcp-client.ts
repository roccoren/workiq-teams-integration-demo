// Minimal, dependency-free MCP (Model Context Protocol) client over stdio.
// Speaks newline-delimited JSON-RPC 2.0 with the WorkIQ MCP server
// (spawned as: workiq mcp -l None [--account <email>]).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { AskError } from "./types.js";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpClientOptions {
  command: string[];
  account?: string;
  requestTimeoutMs?: number;
  onLog?: (line: string) => void;
}

const PROTOCOLS = ["2025-06-18", "2024-11-05", "2024-10-07"];

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;

  /** The exact command this client spawns (for observability/tests). */
  get spawnCommand(): string[] {
    const [cmd, ...rest] = this.opts.command;
    return [cmd, ...rest, "mcp", "-l", "None", ...(this.opts.account ? ["--account", this.opts.account] : [])];
  }
  private rl: readline.Interface | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 0;
  private toolsCache: McpTool[] | null = null;
  private dead = false;
  private bootError: Error | null = null;
  private buffer = "";

  constructor(private opts: McpClientOptions) {}

  get isDead(): boolean { return this.dead; }
  get lastBootError(): Error | null { return this.bootError; }

  /** Spawn the server if needed and complete the MCP handshake. */
  async ensure(): Promise<void> {
    if (this.child && !this.child.killed) return;
    this.dead = false;
    this.bootError = null;
    const [cmd, ...rest] = this.opts.command;
    const args = [...rest, "mcp", "-l", "None", ...(this.opts.account ? ["--account", this.opts.account] : [])];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      this.dead = true;
      this.bootError = e instanceof Error ? e : new Error(String(e));
      throw this.bootError;
    }
    this.child = child;
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (d) => this.opts.onLog?.(d.toString()));
    child.on("error", (e) => {
      this.dead = true;
      this.bootError = e;
      this.rejectAll(e);
    });
    child.on("exit", (code) => {
      this.dead = true;
      this.rejectAll(new Error(`WorkIQ MCP server exited unexpectedly (code ${code})`));
      this.rl?.close();
      this.rl = null;
      this.child = null;
    });
    // Handshake
    let initError: Error | null = null;
    for (const proto of PROTOCOLS) {
      try {
        await this.call("initialize", {
          protocolVersion: proto,
          capabilities: {},
          clientInfo: { name: "workiq-teams-integration-demo", version: "1.0.0" },
        });
        initError = null;
        break;
      } catch (e) {
        initError = e instanceof Error ? e : new Error(String(e));
      }
    }
    if (initError) {
      this.dead = true;
      this.bootError = initError;
      await this.close();
      throw initError;
    }
    this.notify("notifications/initialized", {});
  }

  private handleLine(line: string): void {
    if (this.buffer) { line = this.buffer + line; this.buffer = ""; }
    let msg: { id?: number; method?: string; error?: unknown; result?: unknown };
    try { msg = JSON.parse(line); } catch { this.buffer = line; return; }
    if (msg.method && !msg.id) return; // server notification (logging etc.) — ignore
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`MCP error: ${JSON.stringify(msg.error).slice(0, 500)}`));
      else p.resolve(msg.result);
    }
  }

  private rejectAll(e: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.child || this.child.killed) {
      return Promise.reject(new Error("MCP server is not running"));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${Math.round((timeoutMs ?? this.opts.requestTimeoutMs ?? 240_000) / 1000)}s`));
      }, timeoutMs ?? this.opts.requestTimeoutMs ?? 240_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async listTools(force = false): Promise<McpTool[]> {
    if (this.toolsCache && !force) return this.toolsCache;
    await this.ensure();
    const res = (await this.call("tools/list", {})) as { tools: McpTool[] };
    this.toolsCache = res.tools ?? [];
    return this.toolsCache;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ content: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }> {
    await this.ensure();
    const res = (await this.call("tools/call", { name, arguments: args }, timeoutMs)) as {
      content?: { type: string; text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    if (res?.isError) {
      const text = (res.content?.[0]?.text ?? "") || "unknown error";
      throw new AskError("LIVE_ERROR", `WorkIQ tool "${name}" failed: ${text.slice(0, 600)}`);
    }
    return { content: res?.content ?? [], structuredContent: res?.structuredContent, isError: false };
  }

  async close(): Promise<void> {
    if (!this.child || this.child.killed) return;
    try { this.child.stdin.end(); } catch { /* ignore */ }
    const c = this.child;
    this.child = null;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1500);
      c.once("exit", () => { clearTimeout(t); resolve(); });
      try { c.kill("SIGTERM"); } catch { clearTimeout(t); resolve(); }
    });
    this.rl?.close();
    this.rl = null;
  }
}