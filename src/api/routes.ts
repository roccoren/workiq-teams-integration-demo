// REST + SSE routes for the WorkIQ demo.
import express from "express";
import cors from "cors";
import type { AppConfig } from "../config.js";
import type { WorkIQEngine } from "../workiq/engine.js";
import { AskError } from "../workiq/types.js";
import { streamAsk } from "../workiq/streaming.js";
import type { AccountRegistry } from "../workiq/accounts.js";
import type { OboIdentity, OboTokenService } from "../auth/obo.js";
import { enrollRoutes } from "./enroll.js";

export interface RouteContext {
  engine: WorkIQEngine;
  config: AppConfig;
  warnings: string[];
  accounts: AccountRegistry;
  getEngine: () => WorkIQEngine;
  /** Present when Teams SSO -> Work IQ On-Behalf-Of exchange is configured. */
  obo?: OboTokenService;
  /** Builds an engine bound to one user's delegated token (wired in server.ts). */
  oboEngineFor?: (identity: OboIdentity) => WorkIQEngine;
}

/** Error codes that mean "the caller's credentials are the problem" — answered as 401. */
const AUTH_FAILURE_CODES: Record<string, true> = {
  OBO_CONSENT_REQUIRED: true,
  OBO_UNAUTHORIZED: true,
  OBO_FAILED: true,
  WORKIQ_UNAUTHORIZED: true,
};

const SUGGESTED_PROMPTS = [
  "What meetings do I have this week?",
  "Summarize emails from Sarah about the budget",
  "What is the status of Project Atlas and who owns it?",
  "What does the expense reimbursement policy say about receipts?",
  "What's happening in the #engineering channel?",
  "Summarize the FY26 Q3 company OKRs",
];

export function createApp(ctx: RouteContext): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", enrollRoutes({ accounts: ctx.accounts, config: ctx.config }));

  // ---- per-user engines (Teams SSO -> On-Behalf-Of) ----
  // Keyed by identity + token expiry so one user's consecutive requests reuse a single
  // engine, and a refreshed token starts a fresh one.
  const userEngines = new Map<string, { engine: WorkIQEngine; expiresOn: number }>();

  // Resolves the engine for a request: the caller's own Work IQ session when a Teams SSO
  // token is present and OBO is configured, else the shared server engine. Throws AskError
  // instead of falling back — a silent fallback would answer from the wrong identity.
  async function engineFor(req: express.Request): Promise<{ engine: WorkIQEngine; identity?: OboIdentity }> {
    const header = req.headers.authorization;
    const assertion = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!assertion || !ctx.obo || !ctx.oboEngineFor) return { engine: ctx.getEngine() };

    const identity = await ctx.obo.exchange(assertion);
    const now = Date.now();
    for (const [key, entry] of userEngines) {
      if (entry.expiresOn > now) continue;
      userEngines.delete(key);
      void entry.engine.close().catch(() => undefined);
    }
    const key = `${identity.oid ?? identity.upn ?? "unknown"}:${identity.expiresOn}`;
    let entry = userEngines.get(key);
    if (!entry) {
      entry = { engine: ctx.oboEngineFor(identity), expiresOn: identity.expiresOn };
      userEngines.set(key, entry);
    }
    return { engine: entry.engine, identity };
  }

  function sendError(res: express.Response, e: unknown): void {
    const err = e instanceof AskError ? e : new AskError("LIVE_ERROR", e instanceof Error ? e.message : String(e));
    const status = err.code === "BAD_REQUEST" ? 400 : AUTH_FAILURE_CODES[err.code] ? 401 : 500;
    res.status(status).json({ error: err.message, code: err.code, hint: err.hint });
  }

  // ---- meta ----
  app.get("/api/meta", async (req, res) => {
    let engine = ctx.getEngine();
    let sso: { enabled: boolean; configured: boolean; identity?: { name?: string; upn?: string } } = {
      enabled: false,
      configured: !!(ctx.obo && ctx.oboEngineFor),
    };
    try {
      const resolved = await engineFor(req);
      if (resolved.identity) {
        engine = resolved.engine;
        sso = { enabled: true, configured: true, identity: { name: resolved.identity.name, upn: resolved.identity.upn } };
      }
    } catch {
      // /api/meta stays informational; the data routes surface the exchange failure.
    }
    res.json({
      app: { name: "WorkIQ Query & Use Demo", version: "1.0.0" },
      mode: engine.mode,
      engine: engine.info,
      warnings: ctx.warnings,
      suggestedPrompts: SUGGESTED_PROMPTS,
      capabilities: ["ask", "retrieve", "fetch_blob", "search_paths", "brief", "teams_bot"],
      teamsBot: { enabled: !!(ctx.config.bot.appId && ctx.config.bot.appPassword) },
      accounts: {
        list: ctx.accounts.list,
        default: ctx.accounts.defaultAccount ?? null,
        mappedUsers: ctx.accounts.mapSize,
      },
      enroll: { enabled: true },
      sso,
    });
  });

  // ---- one-shot ask ----
  app.post("/api/ask", async (req, res) => {
    try {
      const { question, conversationId, account } = req.body ?? {};
      if (typeof question !== "string" || !question.trim()) {
        return res.status(400).json({ error: "question is required" });
      }
      const normalized = ctx.accounts.normalize(account);
      if (account !== undefined && normalized === undefined) {
        return res.status(400).json({
          error: `unknown account "${account}" — configure WORKIQ_ACCOUNTS (available: ${ctx.accounts.list.join(", ") || "none"})`,
        });
      }
      const { engine } = await engineFor(req);
      const result = await engine.ask(question.trim(), { conversationId, account: normalized });
      res.json(result);
    } catch (e) {
      sendError(res, e);
    }
  });

  // ---- streaming chat (SSE) ----
  app.post("/api/chat", async (req, res) => {
    const { question, conversationId, account } = req.body ?? {};
    if (typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ error: "question is required" });
    }
    const normalized = ctx.accounts.normalize(account);
    if (account !== undefined && normalized === undefined) {
      return res.status(400).json({
        error: `unknown account "${account}" — configure WORKIQ_ACCOUNTS (available: ${ctx.accounts.list.join(", ") || "none"})`,
      });
    }
    // Resolve the identity before opening the stream so auth failures stay plain JSON.
    let engine: WorkIQEngine;
    try {
      ({ engine } = await engineFor(req));
    } catch (e) {
      return sendError(res, e);
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const ac = new AbortController();
    // Abort only when the client goes away mid-stream (request 'close' fires
    // as soon as the POST body is consumed, which would kill the stream).
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    try {
      for await (const ev of streamAsk(engine, { question: question.trim(), conversationId, account: normalized, signal: ac.signal })) {
        if (res.writableEnded) break;
        switch (ev.type) {
          case "meta": send("meta", ev); break;
          case "status": send("status", ev); break;
          case "token": send("token", { text: ev.text }); break;
          case "citations": send("citations", { citations: ev.citations }); break;
          case "done": send("done", ev); break;
          case "error": send("error", ev); break;
        }
      }
      res.end();
    } catch (e) {
      if (!res.writableEnded) {
        send("error", { code: "LIVE_ERROR", message: e instanceof Error ? e.message : String(e) });
        res.end();
      }
    }
  });

  // ---- grounding retrieval (raw hits) ----
  app.post("/api/retrieve", async (req, res) => {
    try {
      const { queries, strategy } = req.body ?? {};
      const list = Array.isArray(queries) ? queries.filter((q: unknown): q is string => typeof q === "string" && q.trim().length > 0) : [];
      if (!list.length) return res.status(400).json({ error: "queries (string[]) is required" });
      const { engine } = await engineFor(req);
      const result = await engine.retrieve(list, { strategy });
      res.json(result);
    } catch (e) {
      sendError(res, e);
    }
  });

  // ---- use: fetch document content by WorkIQ path ----
  app.post("/api/fetch-blob", async (req, res) => {
    try {
      const { path } = req.body ?? {};
      if (typeof path !== "string" || !path.startsWith("/")) {
        return res.status(400).json({ error: "path (WorkIQ relative path) is required" });
      }
      const { engine } = await engineFor(req);
      const blob = await engine.fetchBlob(path);
      res.json(blob);
    } catch (e) {
      sendError(res, e);
    }
  });

  // ---- use: discover WorkIQ entity paths ----
  app.post("/api/search-paths", async (req, res) => {
    try {
      const { filter } = req.body ?? {};
      if (typeof filter !== "string" || !filter.trim()) return res.status(400).json({ error: "filter is required" });
      const { engine } = await engineFor(req);
      const paths = await engine.searchPaths(filter.trim());
      res.json({ paths });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ---- use: export a brief from chat items ----
  app.post("/api/brief", (req, res) => {
    const { title, items } = req.body ?? {};
    if (!Array.isArray(items)) return res.status(400).json({ error: "items[] is required" });
    const lines: string[] = [];
    lines.push(`# ${typeof title === "string" && title.trim() ? title : "Work IQ Brief"}`);
    lines.push("");
    lines.push(`Generated ${new Date().toISOString()} via the WorkIQ demo · engine: ${ctx.getEngine().mode}`);
    items.forEach((it: { question?: string; answer?: string; citations?: { title?: string; url?: string; snippet?: string }[] }, i: number) => {
      lines.push("", `## ${i + 1}. ${it.question ?? "Question"}`, "");
      lines.push(it.answer ?? "");
      if (it.citations?.length) {
        lines.push("", "### Sources", "");
        it.citations.forEach((c) => lines.push(`- ${c.title ?? "Source"}: ${c.url}`));
      }
    });
    res.json({ markdown: lines.join("\n"), filename: "workiq-brief.md" });
  });

  // ---- health ----
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, mode: ctx.getEngine().mode, uptime: process.uptime() });
  });

  // ---- Teams embedding: allow the UI to be framed by Teams hosts (tab + task module) ----
  // Express sets no X-Frame-Options, so frame-ancestors is the only gate.
  const FRAME_ANCESTORS =
    "frame-ancestors 'self' teams.microsoft.com *.teams.microsoft.com *.skype.com *.teams.microsoft.us " +
    "local.teams.office.com *.office.com *.microsoft365.com *.cloud.microsoft outlook.office.com outlook.office365.com;";
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) res.setHeader("Content-Security-Policy", FRAME_ANCESTORS);
    next();
  });

  // ---- Teams manifest requires reachable privacy / terms URLs ----
  const NOTICES: Record<string, { title: string; body: string }> = {
    "/privacy": {
      title: "Privacy",
      body: "Questions you ask are sent to Microsoft Work IQ (or, in demo mode, answered from a bundled sample " +
        "knowledge base) and kept only in memory for the duration of the conversation. No analytics, no tracking, " +
        "no third-party sharing. Access to your Microsoft 365 data stays governed by your organization's policies.",
    },
    "/terms": {
      title: "Terms of use",
      body: "Provided as-is for demonstration purposes, without warranty of any kind. Answers are AI-generated and " +
        "must be verified before acting on them. Use of Microsoft Work IQ is additionally subject to its own EULA and " +
        "to your Microsoft 365 agreement.",
    },
  };
  app.get(["/privacy", "/terms"], (req, res) => {
    const { title, body } = NOTICES[req.path];
    res.type("html").send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<style>body{font:16px/1.6 system-ui,sans-serif;margin:0 auto;padding:3rem 1.5rem;max-width:44rem;` +
        `color:#e6e8f0;background:#0f1220}h1{font-size:1.4rem}a{color:#7c8cff}</style></head>` +
        `<body><h1>${title}</h1><p>${body}</p><p><a href="/">← WorkIQ Query &amp; Use Demo</a></p></body></html>`,
    );
  });

  // ---- static UI ----
  app.use(express.static("public", { maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));

  // ---- Teams bot endpoint (registered in server.ts to avoid a hard dependency) ----
  app.post("/api/messages", (_req, res) => {
    res.status(501).json({
      error: "Teams bot is not configured.",
      hint: "Set MICROSOFT_APP_ID and MICROSOFT_APP_PASSWORD (Azure Bot registration) and restart.",
    });
  });

  return app;
}