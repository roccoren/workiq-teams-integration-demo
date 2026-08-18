// RemoteEngine: the bot/UI can consume Work IQ through a remote engine service.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.js";
import { RemoteEngine } from "../src/workiq/remote-engine.js";
import type { AppConfig } from "../src/config.js";

let boot: Awaited<ReturnType<typeof startServer>>;
let remote: RemoteEngine;

before(async () => {
  const config: AppConfig = {
    port: 0, mode: "mock", timeoutMs: 30_000, streamChunkMs: 1, bot: {}, teamsApp: { name: "test" },
    workiqMcpUrl: "https://workiq.svc.cloud.microsoft/mcp", workiqScope: "fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask",
  };
  boot = await startServer(config);
  remote = new RemoteEngine(`http://127.0.0.1:${boot.port}`);
  await remote.health();
});

after(async () => {
  boot.server.close();
  await boot.engine.close();
});

test("remote health reflects the engine's mode", () => {
  assert.equal(remote.info.mode, "mock");
  assert.ok(remote.info.detail.includes("127.0.0.1"));
});

test("remote ask returns grounded answers with citations", async () => {
  const result = await remote.ask("Who owns Project Atlas?", { account: undefined });
  assert.match(result.answer, /Alex Morgan/i);
  assert.ok(result.citations.length > 0);
  assert.equal(result.engine, "mock");
});

test("remote retrieve returns hits", async () => {
  const res = await remote.retrieve(["expense policy"]);
  assert.ok(res.hits.length > 0);
  assert.ok(res.markdown.includes("Retrieval API"));
});

test("remote fetchBlob returns base64 content", async () => {
  const blob = await remote.fetchBlob("/documents/d1/content");
  assert.ok(blob.base64.length > 0);
});

test("remote searchPaths filters", async () => {
  const paths = await remote.searchPaths("mail");
  assert.ok(paths.length > 0);
  assert.ok(paths.every((p) => p.path.includes("mail")));
});

test("remote engine surfaces AskError codes from the service", async () => {
  const bad = new RemoteEngine(`http://127.0.0.1:${boot.port}`);
  // unknown account -> the service answers 400 with a code path
  await assert.rejects(
    () => bad.ask("hi", { account: "nobody@else.com" }),
    (e: unknown) => (e as { code?: string }).code === "LIVE_ERROR" || (e as { code?: string }).code === "BAD_REQUEST",
  );
});

test("remote health fails with a clear error when unreachable", async () => {
  const dead = new RemoteEngine("http://127.0.0.1:1");
  await assert.rejects(() => dead.health(), /remote engine unavailable|ENGINE_UNAVAILABLE|fetch failed/i);
});
