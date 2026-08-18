// Work IQ MCP tool semantics — tool names, argument shapes and response parsing —
// shared by every transport (stdio CLI via LiveEngine, hosted HTTP via OboEngine).
// Only the caller differs; the protocol-level contract with Work IQ lives here.
import { parseAskResponse, parseBlobResponse, parseRetrieveResponse } from "./parse.js";
import type { AskResult, SourceKind } from "./types.js";

export interface RetrievalHit {
  id: string;
  kind: SourceKind;
  title: string;
  url: string;
  snippet?: string;
  date?: string;
  sensitivityLabel?: string;
  metadata: Record<string, unknown>;
}

export interface RetrieveResult {
  markdown: string;
  resultCount: number;
  stoppedReason?: string;
  hits: RetrievalHit[];
  durationMs: number;
}

export interface BlobResult {
  base64: string;
  sizeBytes: number;
  mimeHint?: string;
  metadata: Record<string, unknown>;
}

export interface PathEntry {
  path: string;
  operations: string[];
}

/** The single capability these helpers need from a transport. */
export interface McpCaller {
  callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ content: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }>;
}

/** Natural-language Q&A. A parallel grounding `retrieve` supplies titles/metadata for citations. */
export async function askViaMcp(
  caller: McpCaller,
  question: string,
  opts: { conversationId?: string; timeoutMs: number },
): Promise<AskResult> {
  const started = Date.now();
  // Fire the grounding retrieve alongside `ask` — it returns quickly and lets us
  // attach real titles/metadata to the answer's citations.
  const retrieveP = retrieveViaMcp(caller, [question], { timeoutMs: opts.timeoutMs }).catch(() => null);
  const args: Record<string, unknown> = { question };
  if (opts.conversationId) args.conversationId = opts.conversationId;
  const res = await caller.callTool("ask", args, opts.timeoutMs);
  const parsed = parseAskResponse(res as Parameters<typeof parseAskResponse>[0], (await retrieveP)?.hits ?? []);
  return {
    answer: parsed.answer,
    citations: parsed.citations,
    conversationId: parsed.conversationId,
    engine: "live",
    agent: { name: "Microsoft 365 Copilot (Work IQ)" },
    durationMs: Date.now() - started,
  };
}

/** Grounded retrieval: structured hits (emails, files, meetings, chats, people) + grounding markdown. */
export async function retrieveViaMcp(
  caller: McpCaller,
  queries: string[],
  opts: { strategy?: "copilot" | "grounding"; timeoutMs: number },
): Promise<RetrieveResult> {
  const started = Date.now();
  const args: Record<string, unknown> = { query: queries };
  if (opts.strategy) args.strategy = opts.strategy;
  const res = await caller.callTool("retrieve", args, opts.timeoutMs);
  const parsed = parseRetrieveResponse(res as Parameters<typeof parseRetrieveResponse>[0]);
  return { ...parsed, durationMs: Date.now() - started };
}

/** Use flow: download a document's binary content via its Work IQ path. */
export async function fetchBlobViaMcp(caller: McpCaller, path: string, timeoutMs: number): Promise<BlobResult> {
  const res = await caller.callTool("fetch_blob", { path }, timeoutMs);
  return parseBlobResponse(res as Parameters<typeof parseBlobResponse>[0]);
}

/** Use flow: discover Work IQ entity paths by filter (e.g. "mail", "calendar", "messages"). */
export async function searchPathsViaMcp(caller: McpCaller, filter: string, timeoutMs: number): Promise<PathEntry[]> {
  const res = await caller.callTool("search_paths", { filter }, timeoutMs);
  const sc = (res.structuredContent ?? {}) as { paths?: PathEntry[] };
  return sc.paths ?? [];
}
