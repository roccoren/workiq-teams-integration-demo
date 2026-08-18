// Engine factory: picks live (Work IQ over MCP) or mock based on config.
import type { AppConfig } from "../config.js";
import { LiveEngine, type BlobResult, type PathEntry, type RetrievalHit, type RetrieveResult } from "./live-engine.js";
import { MockEngine } from "./mock-engine.js";
import { AskError, type AskResult, type EngineInfo, type EngineMode } from "./types.js";

export interface WorkIQEngine {
  readonly mode: EngineMode;
  readonly info: EngineInfo;
  health(): Promise<void>;
  ask(question: string, opts?: { conversationId?: string; account?: string; signal?: AbortSignal }): Promise<AskResult>;
  retrieve(queries: string[], opts?: { strategy?: "copilot" | "grounding"; account?: string }): Promise<RetrieveResult>;
  fetchBlob(path: string, account?: string): Promise<BlobResult>;
  searchPaths(filter: string, account?: string): Promise<PathEntry[]>;
  close(): Promise<void>;
}

export interface EngineHandle {
  engine: WorkIQEngine;
  resolvedMode: EngineMode;
  /** Present when live mode was requested but the engine had to be replaced / degraded. */
  warnings: string[];
}

export async function createEngine(config: AppConfig, onLog?: (line: string) => void): Promise<EngineHandle> {
  const warnings: string[] = [];

  if (config.mode === "mock") {
    return { engine: new MockEngine(), resolvedMode: "mock", warnings };
  }

  const live = new LiveEngine({
    cliCommand: config.cliCommand,
    account: config.account,
    requestTimeoutMs: config.timeoutMs,
    onLog,
  });

  try {
    await live.health();
    return { engine: live, resolvedMode: "live", warnings };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = e instanceof AskError ? e.hint : undefined;
    warnings.push(`Work IQ live mode unavailable: ${msg}${hint ? ` (${hint})` : ""}`);
    if (config.mode === "live") {
      // Keep the live engine: queries will surface a clear AskError with guidance.
      return { engine: live, resolvedMode: "live", warnings };
    }
    // auto mode → fall back to the mock engine so the demo always runs
    await live.close();
    warnings.push("Falling back to demo (mock) engine. Set WORKIQ_MODE=live to require the real tenant.");
    return { engine: new MockEngine(), resolvedMode: "mock", warnings };
  }
}