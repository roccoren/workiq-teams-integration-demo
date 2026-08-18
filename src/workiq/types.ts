// Shared types for the WorkIQ demo — one contract across live CLI and mock engines.

export type EngineMode = "live" | "mock";

export type SourceKind = "document" | "email" | "meeting" | "chat" | "person" | "link";

export interface Citation {
  /** Stable id for this citation within a result (e.g. "c1") or the live reference id. */
  id: string;
  /** 1-based citation number as it appears in the answer text, e.g. [1], [2]. */
  index: number;
  kind: SourceKind;
  title: string;
  author?: string;
  date?: string;
  /** Teams / Microsoft 365 deep link (live mode) or demo link (mock mode). */
  url: string;
  /** Short evidence snippet shown next to the citation. */
  snippet: string;
  /** Longer excerpt used by the source panel ("use" flow). */
  context?: string;
  /** Sensitivity label when the source carries one (e.g. "Confidential"). */
  sensitivityLabel?: string;
  /** Raw reference payload from the Work IQ CLI (live mode only). */
  raw?: unknown;
}

export interface AskResult {
  /** Markdown answer. Inline citations are kept as [n](url) pairs. */
  answer: string;
  citations: Citation[];
  /** Present when the engine supports multi-turn continuation. */
  conversationId?: string;
  engine: EngineMode;
  agent?: { id?: string; name?: string; provider?: string };
  taskId?: string;
  /** Wall-clock time spent in the engine (ms). */
  durationMs: number;
  /** Work IQ account (email) this answer was produced for. */
  account?: string;
  warnings?: string[];
}

export interface EngineInfo {
  mode: EngineMode;
  label: string;
  /** Human-readable engine status for /api/meta and the UI badge. */
  detail: string;
  account?: string;
  /** True when live mode could not be used (auth missing, CLI missing, etc.). */
  degraded?: boolean;
  degradedReason?: string;
}

export type AskErrorCode =
  | "ENGINE_UNAVAILABLE"
  | "ENGINE_TIMEOUT"
  | "ENGINE_ERROR"
  | "CLI_NOT_FOUND"
  | "AUTH_REQUIRED"
  | "EULA_REQUIRED"
  | "TIMEOUT"
  | "LIVE_ERROR"
  | "BAD_REQUEST"
  // Hosted (HTTP) Work IQ MCP endpoint + On-Behalf-Of token exchange.
  | "WORKIQ_UNAUTHORIZED"
  | "WORKIQ_FORBIDDEN"
  | "OBO_CONSENT_REQUIRED"
  | "OBO_UNAUTHORIZED"
  | "OBO_FAILED";

export class AskError extends Error {
  constructor(
    public code: AskErrorCode,
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "AskError";
  }
}

// ---------- SSE chat event protocol ----------

export type ChatEvent =
  | { type: "meta"; requestId: string; engine: EngineMode; account?: string }
  | { type: "status"; stage: "starting" | "querying" | "retrieving" | "streaming" | "finalizing"; message: string }
  | { type: "token"; text: string }
  | { type: "citations"; citations: Citation[] }
  | { type: "done"; conversationId?: string; engine: EngineMode; durationMs: number; taskId?: string; agent?: AskResult["agent"]; account?: string }
  | { type: "error"; code: AskErrorCode; message: string; hint?: string };

export interface StreamAskOptions {
  question: string;
  conversationId?: string;
  /** Work IQ account (email) to query as; falls back to the engine default. */
  account?: string;
  signal?: AbortSignal;
  /** Called before token streaming starts (e.g. to attach handlers to existing DOM). */
  onBeforeStream?: (result: AskResult) => void;
}