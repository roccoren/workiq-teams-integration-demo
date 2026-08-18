// Self-service enrollment API tests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";

let boot: Awaited<ReturnType<typeof startServer>>;
let base: string;

before(async () => {
  process.env.WORKIQ_ACCOUNTS = "alice@contoso.com";
  process.env.ACCOUNT_MAP_FILE = "/tmp/workiq-test-map.json";
  process.env.WORKIQ_CLI = "node -e process.exit(2)"; // always exits non-zero
  const config: AppConfig = {
    port: 0, mode: "mock", timeoutMs: 30_000, streamChunkMs: 1, bot: {}, teamsApp: { name: "test" },
    workiqMcpUrl: "https://workiq.svc.cloud.microsoft/mcp", workiqScope: "fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask",
  };
  boot = await startServer(config);
  base = `http://127.0.0.1:${boot.port}`;
});

after(async () => {
  delete process.env.WORKIQ_ACCOUNTS;
  delete process.env.ACCOUNT_MAP_FILE;
  delete process.env.WORKIQ_CLI;
  boot.server.close();
  await boot.engine.close();
});

test("enroll rejects invalid emails", async () => {
  const res = await fetch(base + "/api/enroll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "not-an-email" }) });
  assert.equal(res.status, 400);
});

test("enroll rejects already-enrolled accounts", async () => {
  const res = await fetch(base + "/api/enroll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "alice@contoso.com" }) });
  assert.equal(res.status, 409);
});

test("enroll starts a device-login and reports failure when the CLI cannot start", async () => {
  const res = await fetch(base + "/api/enroll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "newuser@contoso.com" }) });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  assert.ok(id);
  // Integration test over HTTP against a real spawned OS process: the settle signal is the
  // child's exit, which fake timers cannot advance and the API exposes only by polling.
  // Bound the wait by wall clock (not by a fixed iteration count) so the assertion is about
  // the contract — "it settles, with a spawn-failure message" — and not about machine speed.
  const deadline = Date.now() + 30_000;
  let status = "pending";
  while (status === "pending" && Date.now() < deadline) {
    await sleep(200);
    const s = await (await fetch(base + "/api/enroll/" + id)).json();
    status = s.status;
    if (s.status === "failed") assert.match(s.error ?? "", /exited|failed|spawn|ENOENT|missing/i);
  }
  assert.notEqual(status, "pending", "enrollment should settle once the CLI process exits");
});

test("enroll 404s for unknown ids", async () => {
  const res = await fetch(base + "/api/enroll/nope");
  assert.equal(res.status, 404);
});