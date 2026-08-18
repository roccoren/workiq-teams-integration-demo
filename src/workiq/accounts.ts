// Account registry: maps Teams users to Work IQ CLI accounts (emails).
// Each account authenticates ONCE via `workiq auth login --account <email>`
// (interactive browser/broker login) on the engine host; the CLI caches that user's refresh token
// under the account key. The MCP server is then spawned per account with
// `workiq mcp --account <email>`, so every query runs with THAT user's own
// delegated permissions — each user sees only their own M365 data.
import fs from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config.js";

export interface TeamsUserIdentity {
  /** Entra object id (from activity.from.aadObjectId) */
  aadObjectId?: string;
  /** Channel user id (from activity.from.id) */
  id?: string;
  /** Display name (from activity.from.name) */
  name?: string;
  /** Email, when available */
  email?: string;
}

export interface AccountResolution {
  account?: string;
  matchedBy?: string;
}

export class AccountRegistry {
  private accounts: string[];
  private map = new Map<string, string>();
  private mapFilePath?: string;

  /**
   * @param workiqAccounts  comma-separated emails (first = default), from WORKIQ_ACCOUNTS
   * @param mapFile         path to a JSON file { "<teamsUserId|aadObjectId|name|email>": "<email>" }
   */
  constructor(workiqAccounts?: string, mapFile?: string) {
    this.accounts = (workiqAccounts ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (mapFile) {
      this.mapFilePath = mapFile.startsWith("/") ? mapFile : join(ROOT, mapFile);
      try {
        const raw = JSON.parse(fs.readFileSync(this.mapFilePath, "utf8")) as Record<string, unknown>;
        for (const [k, v] of Object.entries(raw)) this.map.set(k.trim().toLowerCase(), String(v).trim().toLowerCase());
      } catch (e) {
        console.warn(`[accounts] cannot read ACCOUNT_MAP_FILE ${this.mapFilePath}: ${e instanceof Error ? e.message : e}`);
      }
    }
    // Normalize map values against the configured list (drop unknown emails, warn)
    for (const [k, v] of [...this.map]) {
      if (!this.accounts.includes(v)) {
        console.warn(`[accounts] map entry "${k}" -> "${v}" is not in WORKIQ_ACCOUNTS; ignoring`);
        this.map.delete(k);
      }
    }
  }

  /**
   * Runtime enrollment: add an account (after its interactive login succeeded)
   * and persist an email->email mapping so the bot can resolve it.
   */
  addAccount(email: string): void {
    const e = email.trim().toLowerCase();
    if (!this.accounts.includes(e)) {
      this.accounts.push(e);
      console.log(`[accounts] enrolled account ${e}`);
    }
    this.map.set(e, e);
    if (this.mapFilePath) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.mapFilePath, "utf8")) as Record<string, unknown>;
        raw[e] = e;
        fs.writeFileSync(this.mapFilePath, JSON.stringify(raw, null, 2) + "\n");
      } catch (e2) {
        console.warn(`[accounts] cannot persist mapping: ${e2 instanceof Error ? e2.message : e2}`);
      }
    }
  }

  get list(): string[] { return [...this.accounts]; }
  get defaultAccount(): string | undefined { return this.accounts[0]; }
  get mapSize(): number { return this.map.size; }

  has(account: string): boolean {
    return this.accounts.includes(account.trim().toLowerCase());
  }

  /** Resolve a Teams user to a WorkIQ account email. */
  resolve(user: TeamsUserIdentity): AccountResolution {
    const keys = [user.email, user.aadObjectId, user.id, user.name].filter(Boolean) as string[];
    for (const k of keys) {
      const hit = this.map.get(k.trim().toLowerCase());
      if (hit) return { account: hit, matchedBy: k };
    }
    const email = user.email?.trim().toLowerCase();
    if (email && this.has(email)) return { account: email, matchedBy: "email" };
    return { account: this.defaultAccount, matchedBy: undefined };
  }

  /** Validate a client-supplied account name; falls back to default. */
  normalize(account?: string): string | undefined {
    if (!account) return this.defaultAccount;
    return this.has(account) ? account.trim().toLowerCase() : undefined;
  }
}