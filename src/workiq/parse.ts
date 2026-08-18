// Pure parsers for the Work IQ MCP tool responses — unit-testable without a tenant.
import type { Citation, SourceKind } from "./types.js";
import type { RetrievalHit, RetrieveResult, BlobResult } from "./live-engine.js";

export interface RawAskResponse {
  content?: { type: string; text?: string }[];
  structuredContent?: { answer?: string; conversationId?: string };
  isError?: boolean;
}

export interface RawRetrieveResponse {
  structuredContent?: {
    "application/vnd.ms-workiq.retrieval"?: {
      markdown?: string;
      resultCount?: number;
      stoppedReason?: string;
      retrievalHits?: RawHit[];
    };
  };
}

export interface RawHit {
  id?: string;
  webUrl?: string;
  sensitivityLabel?: string;
  resourceMetadata?: Record<string, unknown>;
}

const DATE_RE = /sentTime|created|modified|lastModified|date/i;

export function kindFromMetadata(md: Record<string, unknown>): SourceKind {
  if ("email" in md) return "email";
  if ("chat" in md) return "chat";
  if ("document" in md) return "document";
  if ("person" in md) return "person";
  if ("event" in md || "meeting" in md) return "meeting";
  return "link";
}

export function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

export function inferTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const file = u.searchParams.get("file");
    if (host.includes("sharepoint") || host.includes("onedrive")) {
      if (file) {
        const name = decodeURIComponent(file.split("/").pop() ?? file).replace(/[<>]/g, "");
        return name ? `Document: ${name}` : "SharePoint document";
      }
      return "SharePoint document";
    }
    if (host.includes("outlook")) return "Email (Outlook)";
    if (host.includes("teams")) return "Teams item";
    if (host.includes("office")) return "Document";
    if (u.pathname.includes("/search")) return "People / file search result";
    return host.replace(/^www\./, "");
  } catch {
    return "Source";
  }
}

/** Parse [n](url) citation markers from an answer, in order. */
export function parseCitationLinks(answer: string): { index: number; url: string }[] {
  const out: { index: number; url: string }[] = [];
  const re = /\[(\d+)\]\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    out.push({ index: Number(m[1]), url: m[2] });
  }
  return out;
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.href.replace(/\/$/, "");
  } catch { return url; }
}

export function parseHits(rawHits: RawHit[] | undefined): RetrievalHit[] {
  return (rawHits ?? []).map((h) => {
    const md = h.resourceMetadata ?? {};
    const kind = kindFromMetadata(md);
    const inner = (Object.values(md)[0] ?? {}) as Record<string, unknown>;
    const title = String(inner.title ?? inner.subject ?? inner.name ?? inferTitleFromUrl(h.webUrl ?? ""));
    const date = Object.entries(inner).find(([k]) => DATE_RE.test(k))?.[1];
    return {
      id: String(h.id ?? Math.random().toString(36).slice(2, 8)),
      kind,
      title: stripTags(title),
      url: h.webUrl ?? "",
      date: date ? String(date) : undefined,
      sensitivityLabel: h.sensitivityLabel,
      metadata: md,
    };
  });
}

/** Build citations for an answer, enriched with metadata from a retrieve() result. */
export function buildCitations(answer: string, hits: RetrievalHit[]): Citation[] {
  const byUrl = new Map<string, RetrievalHit>();
  for (const h of hits) byUrl.set(normalizeUrl(h.url), h);
  return parseCitationLinks(answer).map(({ index, url }) => {
    const hit = byUrl.get(normalizeUrl(url));
    if (hit) {
      return {
        id: `live-${hit.id}`,
        index,
        kind: hit.kind,
        title: hit.title,
        url,
        snippet: hit.snippet ?? "",
        context: hit.snippet,
        date: hit.date,
        sensitivityLabel: hit.sensitivityLabel,
        raw: hit.metadata,
      } satisfies Citation;
    }
    return {
      id: `live-link-${index}`,
      index,
      kind: "link",
      title: inferTitleFromUrl(url),
      url,
      snippet: "",
    } satisfies Citation;
  });
}

export function parseAskResponse(raw: RawAskResponse, hits: RetrievalHit[]): { answer: string; conversationId?: string; citations: Citation[] } {
  const text = (raw.content ?? []).map((c) => c.text ?? "").join("\n");
  const answer = raw.structuredContent?.answer ?? text;
  return { answer, conversationId: raw.structuredContent?.conversationId, citations: buildCitations(answer, hits) };
}

export function parseRetrieveResponse(raw: RawRetrieveResponse): RetrieveResult {
  const sc = raw.structuredContent?.["application/vnd.ms-workiq.retrieval"];
  const hits = parseHits(sc?.retrievalHits);
  return {
    markdown: sc?.markdown ?? "",
    resultCount: sc?.resultCount ?? hits.length,
    stoppedReason: sc?.stoppedReason,
    hits,
    durationMs: 0,
  };
}

export function parseBlobResponse(raw: { structuredContent?: unknown }): BlobResult {
  const sc = (raw.structuredContent ?? {}) as Record<string, unknown>;
  const base64 = String(sc.base64 ?? sc.bytes ?? "");
  const meta = (sc.metadata ?? sc) as Record<string, unknown>;
  return {
    base64,
    sizeBytes: Number(sc.size ?? sc.sizeBytes ?? Math.floor((base64.length * 3) / 4)),
    mimeHint: sc.mimeType ? String(sc.mimeType) : undefined,
    metadata: meta,
  };
}