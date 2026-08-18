// Integration tests: boot the real server (mock engine) and exercise the API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";

let boot: Awaited<ReturnType<typeof startServer>>;
let base: string;

before(async () => {
  process.env.WORKIQ_ACCOUNTS = "alice@contoso.com,bob@contoso.com";
  const config: AppConfig = {
    port: 0,
    mode: "mock",
    timeoutMs: 30_000,
    streamChunkMs: 1,
    bot: {},
    teamsApp: { name: "test" },
    workiqMcpUrl: "https://workiq.svc.cloud.microsoft/mcp",
    workiqScope: "fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask",
  };
  boot = await startServer(config);
  base = `http://127.0.0.1:${boot.port}`;
});

after(async () => {
  delete process.env.WORKIQ_ACCOUNTS;
  boot.server.close();
  await boot.engine.close();
});



test("GET /api/meta reports mock mode + capabilities", async () => {
  const res = await fetch(base + "/api/meta");
  assert.equal(res.status, 200);
  const meta = await res.json();
  assert.equal(meta.mode, "mock");
  assert.ok(meta.capabilities.includes("ask"));
  assert.ok(meta.suggestedPrompts.length > 0);
});

test("POST /api/ask returns a grounded answer with citations", async () => {
  const res = await fetch(base + "/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "What is the status of Project Atlas?" }),
  });
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.match(result.answer, /ON TRACK/);
  assert.ok(result.citations.length >= 2);
  assert.ok(result.conversationId);
});

test("POST /api/ask rejects unknown accounts", async () => {
  const res = await fetch(base + "/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "hi", account: "nobody@else.com" }),
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /WORKIQ_ACCOUNTS/);
});

test("POST /api/ask accepts a configured account (per-user delegation)", async () => {
  const res = await fetch(base + "/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Who owns Project Atlas?", account: "bob@contoso.com" }),
  });
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.account, "bob@contoso.com");
});

test("GET /api/meta lists configured accounts", async () => {
  const meta = await (await fetch(base + "/api/meta")).json();
  assert.deepEqual(meta.accounts.list, ["alice@contoso.com", "bob@contoso.com"]);
  assert.equal(meta.accounts.default, "alice@contoso.com");
});

test("POST /api/ask rejects empty questions", async () => {
  const res = await fetch(base + "/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "  " }),
  });
  assert.equal(res.status, 400);
});

test("POST /api/chat streams SSE events to completion", async () => {
  const res = await fetch(base + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "What meetings do I have this week?" }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await res.text();
  assert.ok(text.includes("event: meta"));
  assert.ok(text.includes("event: token"));
  assert.ok(text.includes("event: citations"));
  assert.ok(text.includes("event: done"));
  assert.ok(!text.includes("event: error"), "no error events");
});

test("POST /api/retrieve returns structured hits", async () => {
  const res = await fetch(base + "/api/retrieve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries: ["Project Atlas", "expense policy"] }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.hits.length > 0);
  assert.ok(data.markdown.includes("Retrieval API"));
});

test("POST /api/fetch-blob returns document content (base64)", async () => {
  const res = await fetch(base + "/api/fetch-blob", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/documents/d1/content" }),
  });
  assert.equal(res.status, 200);
  const blob = await res.json();
  assert.ok(blob.base64.length > 0);
  const text = Buffer.from(blob.base64, "base64").toString("utf8");
  assert.ok(text.includes("Project Atlas"));
});

test("POST /api/brief exports markdown", async () => {
  const res = await fetch(base + "/api/brief", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Atlas brief",
      items: [{ question: "Q?", answer: "A with **bold**", citations: [{ title: "Doc", url: "https://x" }] }],
    }),
  });
  assert.equal(res.status, 200);
  const { markdown } = await res.json();
  assert.ok(markdown.includes("# Atlas brief"));
  assert.ok(markdown.includes("Q?"));
  assert.ok(markdown.includes("https://x"));
});

test("GET /api/health is ok", async () => {
  const res = await fetch(base + "/api/health");
  const h = await res.json();
  assert.equal(h.ok, true);
  assert.equal(h.mode, "mock");
});

test("POST /api/messages returns 501 without bot credentials", async () => {
  const res = await fetch(base + "/api/messages", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
  assert.equal(res.status, 501);
});