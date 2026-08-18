// SSE chat orchestrator: wraps any WorkIQEngine into a stream of ChatEvents.
import type { WorkIQEngine } from "./engine.js";
import { AskError, type ChatEvent } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Split text into small readable chunks for simulated token streaming.
 *  Preserves every character (whitespace included) so chunks rejoin losslessly. */
export function chunkText(text: string, maxLen = 14): string[] {
  const tokens = text.match(/(?:\s+|\S+)/g) ?? [];
  const out: string[] = [];
  let buf = "";
  for (const tok of tokens) {
    if (buf && (buf + tok).length > maxLen) {
      out.push(buf);
      buf = tok;
    } else {
      buf += tok;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export interface StreamAskParams {
  question: string;
  conversationId?: string;
  /** Work IQ account (email) to query as; falls back to the engine default. */
  account?: string;
  signal?: AbortSignal;
  chunkMs?: number;
}

export async function* streamAsk(engine: WorkIQEngine, params: StreamAskParams): AsyncGenerator<ChatEvent> {
  const { question, conversationId, account, signal } = params;
  const chunkMs = params.chunkMs ?? 24;

  yield { type: "meta", requestId: `req-${Date.now().toString(36)}`, engine: engine.mode, account };
  yield { type: "status", stage: "querying", message: engine.mode === "live" ? "Querying Work IQ over your Microsoft 365 data…" : "Retrieving from the demo knowledge base…" };

  let result;
  try {
    result = await engine.ask(question, { conversationId, account, signal });
  } catch (e) {
    if (e instanceof AskError) {
      yield { type: "error", code: e.code, message: e.message, hint: e.hint };
    } else {
      yield { type: "error", code: "LIVE_ERROR", message: e instanceof Error ? e.message : String(e) };
    }
    return;
  }

  yield { type: "status", stage: "streaming", message: "Answering…" };
  const chunks = chunkText(result.answer);
  for (const chunk of chunks) {
    if (signal?.aborted) return;
    yield { type: "token", text: chunk };
    if (chunkMs > 0) await sleep(chunkMs);
  }

  yield { type: "status", stage: "finalizing", message: "Gathering sources…" };
  yield { type: "citations", citations: result.citations };
  yield {
    type: "done",
    conversationId: result.conversationId,
    engine: result.engine,
    durationMs: result.durationMs,
    taskId: result.taskId,
    agent: result.agent,
    account: result.account,
  };
}