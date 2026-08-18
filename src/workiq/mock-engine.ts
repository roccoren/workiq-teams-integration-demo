// Deterministic mock of the Work IQ engine over a sample Contoso knowledge base.
// Implements the same surface as LiveEngine (ask / retrieve / fetchBlob / searchPaths)
// so the demo behaves identically with or without a real M365 tenant.
import { KNOWLEDGE, type KnowledgeDoc, type EmailThread, type Meeting } from "../data/knowledge.js";
import { AskError, type AskResult, type Citation, type EngineInfo, type EngineMode, type SourceKind } from "./types.js";
import type { BlobResult, PathEntry, RetrievalHit, RetrieveResult } from "./live-engine.js";

const STOP = new Set(["the", "a", "an", "and", "or", "but", "of", "for", "to", "in", "on", "at", "with", "about", "from", "my", "me", "i", "is", "are", "was", "were", "do", "does", "did", "can", "could", "would", "should", "what", "when", "where", "which", "who", "how", "please", "tell", "me", "give", "show", "summarize", "find", "any", "all"]);

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
}

function overlap(a: string[], b: string[]): number {
  const bset = new Set(b);
  return a.reduce((n, w) => n + (bset.has(w) ? 1 : 0), 0);
}

interface Scored<T> { item: T; score: number }

function scoreCollection<T extends { id: string; title?: string; keywords?: string[]; content?: string[] }>(query: string, items: T[], extra?: (item: T) => string): Scored<T>[] {
  const q = tokenize(query);
  return items
    .map((item) => {
      const hay = [item.title ?? "", ...(item.keywords ?? []), ...(item.content ?? []), extra ? extra(item) : ""].join(" ").toLowerCase();
      const hayTokens = tokenize(hay);
      const s = overlap(q, hayTokens);
      return { item, score: s };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

function rank<T extends { id: string }>(scored: Scored<T>[], n = 5): T[] {
  return scored.slice(0, n).map((s) => s.item);
}

// ---------- intents ----------

type Intent = "meetings" | "emails" | "documents" | "people" | "policy" | "project" | "chat" | "general";

interface IntentSpec { name: Intent; patterns: RegExp[] }

const INTENTS: IntentSpec[] = [
  { name: "meetings", patterns: [/meeting|calendar|schedule|agenda|sync\b|1:1|all-hands|upcoming|today|tomorrow|this week|when is/i] },
  { name: "emails", patterns: [/email|mail|inbox|message from|emails? about|emails? from|summarize.*(email|mail)/i] },
  { name: "people", patterns: [/who (is|owns|leads|runs|manages)|owner|reporting|org chart|report to|manager|contact|team member|person/i] },
  { name: "policy", patterns: [/policy|expense|reimburs|pto|vacation|leave|security|onboarding|procurement|hardware|travel|receipt|password|mfa|training/i] },
  { name: "project", patterns: [/atlas|project|okr|roadmap|milestone|status|budget|sprint|launch|program|initiative/i] },
  { name: "documents", patterns: [/document|doc\b|file|deck|slide|presentation|spreadsheet|sharepoint|onedrive|find|where is|guide/i] },
  { name: "chat", patterns: [/channel|teams|chat|thread|message(s)? in|discussion/i] },
];

function detectIntent(q: string): Intent {
  for (const spec of INTENTS) if (spec.patterns.some((re) => re.test(q))) return spec.name;
  return "general";
}

// ---------- session (multi-turn) ----------

interface Session { intent: Intent; topic: string; docs: KnowledgeDoc[]; emails: EmailThread[]; meetings: Meeting[] }

const sessions = new Map<string, Session>();

function extractName(q: string): string | null {
  const re = /from\s+([a-z][a-z-]+)(?:\s+([a-z][a-z-]+))?/i;
  const m = q.match(re);
  if (!m) return null;
  return m[2] ? m[1][0].toUpperCase() + m[1].slice(1) + " " + m[2][0].toUpperCase() + m[2].slice(1) : m[1][0].toUpperCase() + m[1].slice(1);
}

function mdLink(title: string, url: string, index: number): string {
  return `[${title}](<url-placeholder>)`.replace("<url-placeholder>", url) + ` [${index}](<url-placeholder>)`.replace("<url-placeholder>", url);
}

function peopleHit(p: { id: string; name: string; title: string; email: string }): RetrievalHit {
  return {
    id: p.id,
    kind: "person",
    title: p.name,
    url: `https://www.office.com/search?q=${encodeURIComponent(p.name)}`,
    snippet: p.title,
    metadata: { person: { name: p.name, title: p.title, email: p.email } },
  };
}

function docHit(d: KnowledgeDoc): RetrievalHit {
  return {
    id: d.id,
    kind: "document",
    title: d.title,
    url: d.teamsUrl,
    snippet: d.content[0].replace(/\*\*/g, ""),
    date: d.updated,
    sensitivityLabel: "Internal",
    metadata: { document: { title: d.title } },
  };
}

function emailHit(e: EmailThread): RetrievalHit {
  return {
    id: e.id,
    kind: "email",
    title: e.subject,
    url: e.url,
    snippet: e.summary,
    date: e.date,
    sensitivityLabel: "Internal",
    metadata: { email: { subject: e.subject, sentTime: e.date, from: e.from } },
  };
}

function meetingHit(m: Meeting): RetrievalHit {
  return {
    id: m.id,
    kind: "meeting",
    title: m.title,
    url: m.teamsUrl,
    snippet: `${m.when} ${m.time} · ${m.organizer}`,
    date: m.when,
    metadata: { event: { title: m.title, when: m.when, time: m.time, organizer: m.organizer } },
  };
}

function chatHits(): RetrievalHit[] {
  const out: RetrievalHit[] = [];
  for (const ch of KNOWLEDGE.channels) {
    for (const msg of ch.messages) {
      out.push({
        id: msg.id,
        kind: "chat",
        title: msg.text.length > 60 ? msg.text.slice(0, 60) + "…" : msg.text,
        url: msg.url,
        snippet: `#${ch.name} · ${msg.author} · ${msg.date}: ${msg.text}`,
        date: msg.date,
        metadata: { chat: { title: `<TeamsMessage>${msg.channel}</TeamsMessage>`, author: msg.author } },
      });
    }
  }
  return out;
}

export class MockEngine {
  readonly mode: EngineMode = "mock";

  get info(): EngineInfo {
    return {
      mode: "mock",
      label: "Work IQ (demo mode)",
      detail: "Simulated Work IQ over the sample Contoso knowledge base — no tenant required",
    };
  }

  async health(): Promise<void> { /* always healthy */ }

  async close(): Promise<void> { sessions.clear(); }

  private buildRetrievalMarkdown(hits: RetrievalHit[]): string {
    const groups: { label: string; hits: RetrievalHit[] }[] = [
      { label: "📧 Emails", hits: hits.filter((h) => h.kind === "email") },
      { label: "📄 Documents", hits: hits.filter((h) => h.kind === "document") },
      { label: "🗓 Meetings", hits: hits.filter((h) => h.kind === "meeting") },
      { label: "👤 People", hits: hits.filter((h) => h.kind === "person") },
      { label: "💬 Teams Messages", hits: hits.filter((h) => h.kind === "chat") },
    ].filter((g) => g.hits.length > 0);
    const lines = ["# 🔎 Retrieval API — Aggregated Results", "", `**Result Count:** ${hits.length} items across ${groups.length} domains`, "", "---"];
    let n = 0;
    for (const g of groups) {
      lines.push("", `## ${g.label}`, "", `**Result Count:** ${g.hits.length} items`, "");
      for (const h of g.hits) {
        n += 1;
        lines.push(`- **${h.title}** [^${h.id}]`);
        lines.push(`  - **snippet:** ${h.snippet}`);
        lines.push(`  - **url:** ${h.url}`);
      }
    }
    return lines.join("\n");
  }

  /** Grounded retrieval over the sample KB — same shape as the live retrieve tool. */
  async retrieve(queries: string[], _opts?: { strategy?: string; account?: string }): Promise<RetrieveResult> {
    const started = Date.now();
    const query = queries.join(" ");
    const hits: RetrievalHit[] = [];
    const seen = new Set<string>();
    const add = (h: RetrievalHit) => { if (!seen.has(h.id)) { seen.add(h.id); hits.push(h); } };

    const docs = rank(scoreCollection<KnowledgeDoc>(query, KNOWLEDGE.documents), 5);
    for (const d of docs) add(docHit(d));
    const emails = rank(scoreCollection<EmailThread>(query, KNOWLEDGE.emails, (e) => e.from + " " + e.summary), 5);
    for (const e of emails) add(emailHit(e));
    const meetings = rank(scoreCollection<Meeting>(query, KNOWLEDGE.meetings, (m) => m.title + " " + m.organizer + " " + m.agenda.join(" ")), 4);
    for (const m of meetings) add(meetingHit(m));
    for (const p of KNOWLEDGE.people) {
      if (overlap(tokenize(query), tokenize(p.name + " " + p.title + " " + p.team)) > 0) add(peopleHit(p));
    }
    for (const h of chatHits()) {
      if (overlap(tokenize(query), tokenize(h.snippet ?? "")) > 0) add(h);
    }
    return {
      markdown: this.buildRetrievalMarkdown(hits),
      resultCount: hits.length,
      stoppedReason: hits.length === 0 ? "noResults" : "completed",
      hits,
      durationMs: Date.now() - started,
    };
  }

  /** Use flow: return base64 content of a sample document by WorkIQ path. */
  async fetchBlob(path: string): Promise<BlobResult> {
    const id = path.split("/").pop()?.replace(/^content$/, "") ?? "";
    const doc = KNOWLEDGE.documents.find((d) => path.includes(d.id));
    if (!doc) throw new AskError("LIVE_ERROR", `No sample document for path "${path}" (try /documents/<id>/content)`);
    const text = doc.content.join("\n\n");
    return {
      base64: Buffer.from(text, "utf8").toString("base64"),
      sizeBytes: Buffer.byteLength(text, "utf8"),
      mimeHint: "text/markdown",
      metadata: { title: doc.title, path },
    };
  }

  /** Use flow: mock Graph-like entity paths. */
  async searchPaths(filter: string): Promise<PathEntry[]> {
    const all: PathEntry[] = [
      { path: "/me/mailFolders/inbox/messages", operations: ["fetch"] },
      { path: "/me/calendar/calendarView", operations: ["fetch"] },
      { path: "/me/events/{event-id}", operations: ["fetch", "update"] },
      { path: "/drives/{drive-id}/items/{item-id}/content", operations: ["fetch"] },
      { path: "/chats/{chat-id}/messages", operations: ["fetch", "create"] },
      { path: "/users/{user-id}", operations: ["fetch"] },
    ];
    const f = filter.toLowerCase();
    return all.filter((p) => p.path.toLowerCase().includes(f));
  }

  /** Primary query path: Q&A over the sample KB, in the same shape as live Work IQ answers. */
  async ask(question: string, opts?: { conversationId?: string; account?: string }): Promise<AskResult> {
    const started = Date.now();
    const account = opts?.account;
    const session = opts?.conversationId ? sessions.get(opts.conversationId) : undefined;
    const intent = session && /^(and|also|what about|who|when|how|next|more)/i.test(question) ? session.intent : detectIntent(question);
    const q = question;

    const citations: Citation[] = [];
    const pushCit = (kind: SourceKind, title: string, url: string, snippet: string, date?: string) => {
      citations.push({ id: `mock-${citations.length + 1}`, index: citations.length + 1, kind, title, url, snippet, context: snippet, date });
    };
    const link = (n: number): string => {
      const c = citations[n - 1];
      return `[${n}](${c.url})`;
    };

    let answer = "";

    const docs = rank(scoreCollection<KnowledgeDoc>(q, KNOWLEDGE.documents), 4);
    const emails = rank(scoreCollection<EmailThread>(q, KNOWLEDGE.emails, (e) => e.from + " " + e.summary), 4);
    const meetings = rank(scoreCollection<Meeting>(q, KNOWLEDGE.meetings, (m) => m.title + " " + m.organizer + " " + m.agenda.join(" ")), 4);

    if (intent === "meetings") {
      const list = meetings.length ? meetings : KNOWLEDGE.meetings;
      for (const m of list) pushCit("meeting", m.title, m.teamsUrl, `${m.when} ${m.time} · ${m.organizer}`, m.when);
      const lines = list.map((m, i) => `${i + 1}. **${m.title}** — ${m.when}, ${m.time}, organizer ${m.organizer} ${link(i + 1)}`);
      answer = [
        `I found **${list.length} meetings/events** matching your request. ${link(1)}`,
        "",
        "### Schedule",
        ...lines,
        "",
        "Suggested preparation: for each meeting I can give you the **agenda, attendees, and related files** — just ask.",
      ].join("\n");
    } else if (intent === "emails") {
      const fromName = extractName(q);
      const list = emails.length ? emails : KNOWLEDGE.emails.slice(0, 3);
      if (fromName) {
        const byFrom = KNOWLEDGE.emails.filter((e) => e.from.toLowerCase().includes(fromName.toLowerCase()));
        const picked = byFrom.length ? byFrom : list;
        for (const e of picked) pushCit("email", e.subject, e.url, e.summary, e.date);
        answer = [
          `I found ${picked.length} email thread${picked.length === 1 ? "" : "s"} from **${fromName}** matching your request. ${link(1)}`,
          "",
          ...picked.map((e, i) => `- **${e.subject}** (${e.date}) ${link(i + 1)} — ${e.summary}`),
          "",
          "I can also draft a **reply draft** or **extract action items** from any of these threads — just ask.",
        ].join("\n");
      } else {
        for (const e of list) pushCit("email", e.subject, e.url, e.summary, e.date);
        answer = [
          `I found **${list.length} emails** related to "${q}". ${link(1)}`,
          "",
          ...list.map((e, i) => `- **${e.subject}** — ${e.from}, ${e.date} ${link(i + 1)}`),
          "",
          "Tip: ask for emails **from a specific person** (e.g. “emails from Sarah about the budget”) for a tighter search.",
        ].join("\n");
      }
    } else if (intent === "people") {
      const nameMatch = KNOWLEDGE.people.find((p) => q.toLowerCase().includes(p.name.split(" ")[0].toLowerCase()));
      if (nameMatch) {
        pushCit("person", nameMatch.name, `https://www.office.com/search?q=${encodeURIComponent(nameMatch.name)}`, `${nameMatch.title} · ${nameMatch.team} · ${nameMatch.email}`);
        answer = [
          `**${nameMatch.name}** — ${nameMatch.title} (${nameMatch.team}). ${link(1)}`,
          "",
          `- Email: ${nameMatch.email}`,
          `- Manager: ${nameMatch.manager}`,
          `- Location: ${nameMatch.location}`,
          "",
          `Bio: ${nameMatch.bio}`,
          "",
          "You can also ask “who owns Project Atlas?” or “what is Sarah’s team?” for more context.",
        ].join("\n");
      } else if (/owns|owner|leads|leaders|who/i.test(q)) {
        const target = /atlas/i.test(q) ? "Project Atlas" : /okr|goal/i.test(q) ? "Q3 OKRs" : /security|it/i.test(q) ? "Information Security" : null;
        if (target) {
          const map: Record<string, string[]> = {
            "Project Atlas": ["Alex Morgan", "Sarah Chen", "David Kim"],
            "Q3 OKRs": ["James O'Brien", "Alex Morgan", "Sarah Chen"],
            "Information Security": ["Tom Becker"],
          };
          for (const n of map[target]) {
            const p = KNOWLEDGE.people.find((x) => x.name === n)!;
            pushCit("person", p.name, `https://www.office.com/search?q=${encodeURIComponent(p.name)}`, `${p.title}`);
          }
          answer = [
            `Ownership of **${target}**:`,
            "",
            ...map[target].map((n, i) => {
              const p = KNOWLEDGE.people.find((x) => x.name === n)!;
              return `- **${n}** — ${p.title} ${link(i + 1)}`;
            }),
            "",
            `${target} is a **cross-functional program**; for day-to-day questions contact the listed owners in Teams.`,
          ].join("\n");
        } else {
          pushCit("person", KNOWLEDGE.people[0].name, `https://www.office.com/search?q=${encodeURIComponent(KNOWLEDGE.people[0].name)}`, KNOWLEDGE.people[0].title);
          answer = `Here's who I found for "${q}": **${KNOWLEDGE.people[0].name}** (${KNOWLEDGE.people[0].title}) ${link(1)}. Try "who owns Project Atlas?" or "who is the CTO?" for specifics.`;
        }
      } else {
        for (const p of KNOWLEDGE.people.slice(0, 4)) pushCit("person", p.name, `https://www.office.com/search?q=${encodeURIComponent(p.name)}`, `${p.title} · ${p.email}`);
        answer = [
          `People at Contoso matching "${q}":`,
          "",
          ...citations.map((c, i) => `- **${c.title}** — ${c.snippet} ${link(i + 1)}`),
          "",
          "Ask “who owns Project Atlas?” or “show the org chart” for structure.",
        ].join("\n");
      }
    } else if (intent === "policy") {
      const picked = docs.slice(0, 3);
      if (!picked.length) {
        answer = `I couldn't find a policy matching "${q}". Try "expense policy", "PTO policy", or "security policy".`;
      } else {
        for (const d of picked) pushCit("document", d.title, d.teamsUrl, d.content[0].replace(/\*\*/g, ""), d.updated);
        const qTokens = tokenize(q);
        const facts: { text: string; doc: KnowledgeDoc }[] = [];
        for (const d of picked) {
          for (const line of d.content) {
            if (overlap(qTokens, tokenize(line)) > 0) facts.push({ text: line.replace(/\*\*/g, "**"), doc: d });
          }
        }
        const pickedFacts = facts.slice(0, 6);
        answer = [
          `Here's what the policies say about **"${q}"**:`,
          "",
          ...pickedFacts.map((f, i) => {
            const idx = picked.findIndex((d) => d.id === f.doc.id);
            return `- ${f.text} ${link(idx + 1)}`;
          }),
          "",
          `Full policy: **${picked[0].title}** ${link(1)} (owner: ${picked[0].owner}, updated ${picked[0].updated}).`,
          "",
          "I can also **summarize the whole policy** or find the **approval workflow** if you need it.",
        ].join("\n");
      }
    } else if (intent === "project") {
      const picked = docs.length ? docs : KNOWLEDGE.documents.filter((d) => d.id === "d1" || d.id === "d10");
      for (const d of picked) pushCit("document", d.title, d.teamsUrl, d.content[0].replace(/\*\*/g, ""), d.updated);
      const atlas = KNOWLEDGE.documents.filter((d) => /atlas/i.test(d.title));
      const qLower = q.toLowerCase();
      if (/atlas/i.test(qLower) && atlas.length) {
        const status = atlas[0];
        const roadmap = atlas.find((d) => /roadmap/i.test(d.title)) ?? atlas[1];
        const statusIdx = picked.findIndex((d) => d.id === status.id);
        const roadmapIdx = picked.findIndex((d) => d.id === roadmap.id);
        answer = [
          "### Project Atlas — status & ownership",
          "",
          `**Overall status: ON TRACK.** ${status.content[0].replace(/\*\*/g, "")} ${link(statusIdx + 1)}`,
          "",
          "**Milestones completed (Q3):**",
          ...status.content.slice(1, 4).map((c) => `- ${c.replace(/\*\*/g, "")}`),
          "",
          `**Roadmap:** ${roadmap.content[2].replace(/\*\*/g, "")} ${link(roadmapIdx + 1)}`,
          "",
          `**Ownership:** Alex Morgan (executive owner) · Sarah Chen (product & budget) · David Kim (engineering) ${link(1)}`,
          "",
          `**Budget:** Q3 allocation $1.2M approved, spend $780K (65%) ${link(1)}.`,
          "",
          "Want me to **summarize the latest Atlas sync**, pull **sprint risks**, or build a **1-page brief** you can share?",
        ].join("\n");
      } else {
        answer = [
          `Here's what I found about "${q}":`,
          "",
          ...picked.map((d, i) => `- **${d.title}** (${d.kind}, owner ${d.owner}, updated ${d.updated}) ${link(i + 1)}`),
          "",
          "I can **summarize any of these documents** or compare them — just ask.",
        ].join("\n");
      }
    } else if (intent === "chat") {
      const hits = chatHits();
      const picked = hits.slice(0, 4);
      for (const h of picked) pushCit("chat", h.title, h.url, h.snippet ?? "", h.date);
      answer = [
        `Recent Teams conversations matching "${q}":`,
        "",
        ...citations.map((c, i) => `- ${c.snippet} ${link(i + 1)}`),
        "",
        "You can open any message directly in Teams. Ask “what’s happening in #engineering?” for a channel digest.",
      ].join("\n");
    } else {
      // general: best-effort summary across domains
      const d = docs.slice(0, 2);
      const e = emails.slice(0, 2);
      const m = meetings.slice(0, 2);
      for (const x of d) pushCit("document", x.title, x.teamsUrl, x.content[0].replace(/\*\*/g, ""), x.updated);
      for (const x of e) pushCit("email", x.subject, x.url, x.summary, x.date);
      for (const x of m) pushCit("meeting", x.title, x.teamsUrl, `${x.when} ${x.time} · ${x.organizer}`, x.when);
      answer = [
        `Here's what I found across your internal information for "${q}":`,
        "",
        ...d.map((x, i) => `- **Document:** ${x.title} ${link(i + 1)}`),
        ...e.map((x, i) => `- **Email:** ${x.subject} (${x.from}, ${x.date}) ${link(d.length + i + 1)}`),
        ...m.map((x, i) => `- **Meeting:** ${x.title} — ${x.when} ${x.time} ${link(d.length + e.length + i + 1)}`),
        "",
        "I can go deeper on any of these — summarize the document, draft a reply, or prep for the meeting.",
      ].join("\n");
    }

    const conversationId = opts?.conversationId ?? `mock-${Date.now().toString(36)}`;
    sessions.set(conversationId, { intent, topic: q, docs, emails, meetings });
    return { answer, citations, conversationId, engine: "mock", durationMs: Date.now() - started, account };
  }
}