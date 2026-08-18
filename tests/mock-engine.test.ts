// Unit tests for the mock engine + streaming helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEngine } from "../src/workiq/mock-engine.js";
import { chunkText } from "../src/workiq/streaming.js";

test("chunkText splits and reassembles without data loss", () => {
  const text = "Hello world! **This** is a [1](https://x.com) test.\n\nSecond paragraph with more words.";
  const chunks = chunkText(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.length > 3);
});

test("ask: meetings intent lists meetings with citations", async () => {
  const engine = new MockEngine();
  const result = await engine.ask("What meetings do I have this week?");
  assert.equal(result.engine, "mock");
  assert.match(result.answer, /meetings/);
  assert.ok(result.citations.length >= 2);
  assert.ok(result.citations.every((c) => c.kind === "meeting"));
  assert.ok(result.conversationId, "returns conversationId for continuation");
  // every [n](url) in answer has a matching citation
  const re = /\[(\d+)\]\(https?:\/\/[^)\s]+\)/g;
  const nums = [...result.answer.matchAll(re)].map((m) => Number(m[1]));
  for (const n of nums) assert.ok(result.citations.some((c) => c.index === n), `citation ${n} exists`);
});

test("ask: emails-from intent finds Sarah's budget threads", async () => {
  const engine = new MockEngine();
  const result = await engine.ask("Summarize emails from Sarah about the budget");
  assert.match(result.answer, /Sarah/i);
  assert.ok(result.citations.some((c) => c.kind === "email"));
});

test("ask: policy intent returns grounded policy bullets", async () => {
  const engine = new MockEngine();
  const result = await engine.ask("What does the expense reimbursement policy say about receipts?");
  assert.match(result.answer, /receipt/i);
  assert.ok(result.citations.length > 0);
  assert.ok(result.citations.every((c) => c.kind === "document"));
});

test("ask: people intent finds project owners", async () => {
  const engine = new MockEngine();
  const result = await engine.ask("Who owns Project Atlas?");
  assert.match(result.answer, /Alex Morgan/i);
  assert.ok(result.citations.some((c) => c.kind === "person"));
});

test("ask: project status returns milestone content with citations", async () => {
  const engine = new MockEngine();
  const result = await engine.ask("What is the status of Project Atlas?");
  assert.match(result.answer, /ON TRACK/i);
  assert.ok(result.citations.some((c) => c.kind === "document"));
});

test("ask: multi-turn continuation works", async () => {
  const engine = new MockEngine();
  const first = await engine.ask("What meetings do I have this week?");
  const second = await engine.ask("and what is the agenda?", { conversationId: first.conversationId });
  assert.match(second.answer, /agenda|Agenda/i);
});

test("retrieve returns WorkIQ-shaped aggregated markdown and structured hits", async () => {
  const engine = new MockEngine();
  const result = await engine.retrieve(["Project Atlas status", "expense policy"]);
  assert.ok(result.markdown.includes("Retrieval API"));
  assert.ok(result.markdown.includes("[^"));
  assert.ok(result.hits.length > 0);
  for (const h of result.hits) {
    assert.ok(h.url.startsWith("http"));
    assert.ok(["email", "document", "meeting", "person", "chat"].includes(h.kind));
  }
  assert.ok(result.hits.some((h) => h.kind === "document"), "documents found");
});

test("fetchBlob returns base64 content for sample docs", async () => {
  const engine = new MockEngine();
  const blob = await engine.fetchBlob("/documents/d1/content");
  assert.ok(blob.base64.length > 0);
  assert.equal(Buffer.from(blob.base64, "base64").toString("utf8").includes("Project Atlas"), true);
});

test("searchPaths filters by name", async () => {
  const engine = new MockEngine();
  const paths = await engine.searchPaths("mail");
  assert.ok(paths.length > 0);
  assert.ok(paths.every((p) => p.path.includes("mail")));
});
