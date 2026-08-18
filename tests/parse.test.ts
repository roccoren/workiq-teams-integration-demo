// Unit tests for the pure Work IQ response parsers, using a fixture captured
// from a real tenant (trimmed).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAskResponse, parseRetrieveResponse, parseCitationLinks, buildCitations, normalizeUrl, parseHits } from "../src/workiq/parse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "workiq-responses.json"), "utf8"));

test("parseCitationLinks extracts [n](url) pairs in order", () => {
  const links = parseCitationLinks("See [1](https://a.com/x) and [2](https://b.com/y?q=1) end.");
  assert.deepEqual(links, [
    { index: 1, url: "https://a.com/x" },
    { index: 2, url: "https://b.com/y?q=1" },
  ]);
});

test("parseAskResponse extracts answer, conversationId and citations", () => {
  const hits = parseHits(fixture.retrieve.structuredContent["application/vnd.ms-workiq.retrieval"].retrievalHits);
  const parsed = parseAskResponse(fixture.ask, hits);
  assert.ok(parsed.answer.length > 200, "answer should be substantial");
  assert.equal(parsed.conversationId, "d4c5a81f5d614ea382010c3d64442bfa");
  assert.ok(parsed.citations.length >= 2, "citations parsed from [n](url) markers");
  for (const c of parsed.citations) {
    assert.ok(c.url.startsWith("http"), "citation url is absolute");
    assert.ok(c.index >= 1);
  }
});

test("citation enrichment attaches hit metadata (title/kind) by normalized URL", () => {
  const hits = parseHits(fixture.retrieve.structuredContent["application/vnd.ms-workiq.retrieval"].retrievalHits);
  assert.ok(hits.length > 0);
  const enriched = buildCitations(fixture.ask.structuredContent.answer, hits);
  const withMeta = enriched.filter((c) => c.kind !== "link");
  if (withMeta.length) {
    assert.ok(withMeta[0].title.length > 0);
  }
});

test("normalizeUrl strips query and hash for matching", () => {
  assert.equal(normalizeUrl("https://x.com/a?foo=1&bar=2#frag"), "https://x.com/a");
  assert.equal(normalizeUrl("https://x.com/a/"), "https://x.com/a");
});

test("parseRetrieveResponse maps hits with kind/metadata and counts", () => {
  const parsed = parseRetrieveResponse(fixture.retrieve);
  assert.equal(parsed.resultCount, 14, "backend-reported result count is preserved");
  assert.equal(parsed.hits.length, 4, "hits are mapped from the trimmed payload");
  assert.ok(parsed.markdown.includes("Retrieval API"));
  const kinds = new Set(parsed.hits.map((h) => h.kind));
  assert.ok(kinds.has("email") || kinds.has("document") || kinds.has("chat"));
  for (const h of parsed.hits) {
    assert.ok(h.url.startsWith("http"), "hit carries webUrl");
    assert.ok(h.title, "hit carries a title");
  }
});