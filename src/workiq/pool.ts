// Per-account MCP client pool.
// Work IQ CLI caches tokens per `--account`; we keep one MCP server process per
// account so each Teams user's queries run with their own delegated identity.
import { McpClient } from "./mcp-client.js";

export interface PoolOptions {
  command: string[];
  /** Default account (spawned without --account when unset). */
  account?: string;
  requestTimeoutMs?: number;
  onLog?: (line: string) => void;
  /** Close idle per-account processes after this long (ms). */
  idleMs?: number;
}

export class McpClientPool {
  private clients = new Map<string, { client: McpClient; idle?: NodeJS.Timeout }>();

  constructor(private opts: PoolOptions) {}

  /** Normalized pool key: "" = default (no --account), otherwise the email. */
  private key(account?: string): string {
    return account ?? this.opts.account ?? "";
  }

  get(account?: string): McpClient {
    const key = this.key(account);
    let entry = this.clients.get(key);
    if (!entry) {
      const client = new McpClient({
        command: this.opts.command,
        account: key || undefined,
        requestTimeoutMs: this.opts.requestTimeoutMs,
        onLog: this.opts.onLog,
      });
      entry = { client };
      this.clients.set(key, entry);
    }
    this.touch(key, entry);
    return entry.client;
  }

  private touch(key: string, entry: { client: McpClient; idle?: NodeJS.Timeout }): void {
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = setTimeout(() => {
      void this.close(key);
    }, this.opts.idleMs ?? 15 * 60_000);
    entry.idle.unref?.();
  }

  async close(key?: string): Promise<void> {
    const k = this.key(key);
    const entry = this.clients.get(k);
    if (!entry) return;
    if (entry.idle) clearTimeout(entry.idle);
    this.clients.delete(k);
    await entry.client.close();
  }

  async closeAll(): Promise<void> {
    for (const k of [...this.clients.keys()]) await this.close(k);
  }

  get size(): number { return this.clients.size; }

  /** Observability: per-key spawn commands. */
  describeClients(): { key: string; command: string[] }[] {
    return [...this.clients.entries()].map(([key, { client }]) => ({ key, command: client.spawnCommand }));
  }
}