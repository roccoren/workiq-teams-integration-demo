// RemoteEngine: a WorkIQEngine that proxies to a remote demo/engine service over HTTP.
// Use when the Teams bot must NOT spawn the WorkIQ CLI itself — e.g. bot deployed in
// Azure while the engine (hosting `workiq mcp` + per-user cached tokens) runs on
// another machine. The remote service exposes /api/ask, /api/chat, /api/retrieve,
// /api/fetch-blob, /api/search-paths — all of which internally drive Work IQ MCP.
import { AskError, type AskResult, type EngineInfo, type EngineMode } from "./types.js";
import type { BlobResult, PathEntry, RetrievalHit, RetrieveResult } from "./live-engine.js";
import type { WorkIQEngine } from "./engine.js";

export class RemoteEngine implements WorkIQEngine {
  readonly mode: EngineMode = "live";
  private remoteMode: EngineMode = "live";
  private infoDetail = "";
  private lastError: Error | null = null;

  constructor(private baseUrl: string) {}

  private url(path: string): string {
    return this.baseUrl.replace(/\/$/, "") + path;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // Transient connection failures (e.g. engine warm-up) — retry once.
      await new Promise((r2) => setTimeout(r2, 1500));
      res = await fetch(this.url(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { error?: string; code?: string; hint?: string };
        detail = j.error ?? "";
        if (j.code) throw new AskError(j.code as AskError["code"], detail || `remote error ${res.status}`, j.hint);
      } catch (e) {
        if (e instanceof AskError) throw e;
        detail = await res.text().catch(() => "");
      }
      throw new AskError("LIVE_ERROR", detail || `remote error ${res.status} on ${path}`);
    }
    return (await res.json()) as T;
  }

  async health(): Promise<void> {
    try {
      const res = await fetch(this.url("/api/meta"));
      if (!res.ok) throw new Error(`remote /api/meta -> ${res.status}`);
      const meta = (await res.json()) as { mode: EngineMode; engine: { label?: string; detail?: string } };
      this.remoteMode = meta.mode;
      this.infoDetail = meta.engine?.detail ?? "";
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e : new Error(String(e));
      throw new AskError("ENGINE_UNAVAILABLE", `remote engine unavailable: ${e instanceof Error ? e.message : e}`, "Check ENGINE_API_URL and that the engine service is running.");
    }
  }

  get info(): EngineInfo {
    return {
      mode: this.remoteMode,
      label: `Work IQ (remote engine)`,
      detail: `${this.baseUrl} · ${this.infoDetail}`,
      degraded: !!this.lastError,
      degradedReason: this.lastError?.message,
    };
  }

  async ask(question: string, opts?: { conversationId?: string; account?: string; signal?: AbortSignal }): Promise<AskResult> {
    return this.post<AskResult>("/api/ask", { question, conversationId: opts?.conversationId, account: opts?.account });
  }

  async retrieve(queries: string[], opts?: { strategy?: "copilot" | "grounding"; account?: string }): Promise<RetrieveResult> {
    return this.post<RetrieveResult>("/api/retrieve", { queries, strategy: opts?.strategy, account: opts?.account });
  }

  async fetchBlob(path: string, account?: string): Promise<BlobResult> {
    return this.post<BlobResult>("/api/fetch-blob", { path, account });
  }

  async searchPaths(filter: string, account?: string): Promise<PathEntry[]> {
    const res = await this.post<{ paths: PathEntry[] }>("/api/search-paths", { filter, account });
    return res.paths;
  }

  async close(): Promise<void> { /* nothing to close — no local processes */ }
}