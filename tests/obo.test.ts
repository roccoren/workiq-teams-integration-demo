// On-Behalf-Of: error mapping, assertion cache, and per-user engine routing. No network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { OboTokenService, mapOboError, type OboIdentity, type OboOptions } from "../src/auth/obo.js";
import { createApp } from "../src/api/routes.js";
import { AccountRegistry } from "../src/workiq/accounts.js";
import { AskError, type AskResult } from "../src/workiq/types.js";
import type { WorkIQEngine } from "../src/workiq/engine.js";
import type { AppConfig } from "../src/config.js";

const OPTS: OboOptions = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  clientId: "22222222-2222-2222-2222-222222222222",
  clientSecret: "secret",
  scope: "fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask",
};

// ---------- error mapping ----------

test("mapOboError flags missing consent with an admin-consent URL", () => {
  const err = mapOboError(
    { errorCode: "invalid_grant", errorMessage: "AADSTS65001: The user or administrator has not consented to use the application." },
    OPTS,
  );
  assert.equal(err.code, "OBO_CONSENT_REQUIRED");
  assert.ok(err.hint?.includes(`https://login.microsoftonline.com/${OPTS.tenantId}/adminconsent?client_id=${OPTS.clientId}`));
  assert.ok(err.hint?.includes(OPTS.scope));
});

test("mapOboError flags a rejected assertion as unauthorized", () => {
  const err = mapOboError({ errorCode: "invalid_client", errorMessage: "AADSTS500131: Assertion audience does not match." }, OPTS);
  assert.equal(err.code, "OBO_UNAUTHORIZED");
  assert.ok(err.hint?.includes(OPTS.clientId));
});

test("mapOboError falls back to OBO_FAILED for unrecognised failures", () => {
  const err = mapOboError(new Error("getaddrinfo ENOTFOUND login.microsoftonline.com"), OPTS);
  assert.equal(err.code, "OBO_FAILED");
  assert.ok(err.message.includes("ENOTFOUND"));
  assert.ok(err.hint?.includes("AAD_TENANT_ID"));
});

// ---------- assertion cache ----------

function jwt(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
}

/** Swaps in a recorder for the private MSAL client — the only seam that keeps this offline. */
function stubMsal(svc: OboTokenService, lifetimeMs: number): { calls: number } {
  const state = { calls: 0 };
  const internals = svc as unknown as { msal: { acquireTokenOnBehalfOf: () => Promise<unknown> } };
  internals.msal = {
    acquireTokenOnBehalfOf: async () => {
      state.calls += 1;
      return { accessToken: `delegated-${state.calls}`, expiresOn: new Date(Date.now() + lifetimeMs), account: null, idTokenClaims: {} };
    },
  };
  return state;
}

test("exchange caches an identity per assertion", async () => {
  const svc = new OboTokenService(OPTS);
  const calls = stubMsal(svc, 3_600_000);
  const assertion = jwt({ oid: "user-1", preferred_username: "alice@contoso.com", name: "Alice", tid: OPTS.tenantId });

  const first = await svc.exchange(assertion);
  const second = await svc.exchange(assertion);
  assert.equal(calls.calls, 1);
  assert.equal(second.token, first.token);
  assert.equal(first.oid, "user-1");
  assert.equal(first.upn, "alice@contoso.com");
  assert.equal(first.name, "Alice");
  assert.equal(first.tid, OPTS.tenantId);

  await svc.exchange(jwt({ oid: "user-2" }));
  assert.equal(calls.calls, 2);
});

test("exchange re-acquires inside the 60s expiry skew", async () => {
  const svc = new OboTokenService(OPTS);
  const calls = stubMsal(svc, 30_000);
  const assertion = jwt({ oid: "user-1" });

  const first = await svc.exchange(assertion);
  const second = await svc.exchange(assertion);
  assert.equal(calls.calls, 2);
  assert.notEqual(second.token, first.token);
});

// ---------- routes ----------

function stubEngine(label: string): WorkIQEngine & { asks: string[] } {
  const asks: string[] = [];
  return {
    asks,
    mode: "mock",
    info: { mode: "mock", label, detail: label },
    async health() {},
    async ask(question: string): Promise<AskResult> {
      asks.push(question);
      return { answer: `${label}: ${question}`, citations: [], engine: "mock", durationMs: 1 };
    },
    async retrieve() {
      return { markdown: "", resultCount: 0, hits: [], durationMs: 1 };
    },
    async fetchBlob() {
      return { base64: "", sizeBytes: 0, metadata: {} };
    },
    async searchPaths() {
      return [];
    },
    async close() {},
  };
}

const CONFIG: AppConfig = {
  port: 0,
  mode: "mock",
  timeoutMs: 30_000,
  streamChunkMs: 1,
  bot: {},
  teamsApp: { name: "test" },
  workiqMcpUrl: "https://workiq.svc.cloud.microsoft/mcp",
  workiqScope: OPTS.scope,
};

const shared = stubEngine("shared");
const perUser = stubEngine("per-user");
const IDENTITY: OboIdentity = {
  token: "delegated",
  expiresOn: Date.now() + 3_600_000,
  oid: "user-1",
  upn: "alice@contoso.com",
  name: "Alice Adams",
};
let exchangeFails: AskError | undefined;
let server: Server;
let base: string;

before(async () => {
  const obo = {
    async exchange(assertion: string): Promise<OboIdentity> {
      if (exchangeFails) throw exchangeFails;
      assert.equal(assertion, "sso-token");
      return IDENTITY;
    },
  } as unknown as OboTokenService;

  const app = createApp({
    engine: shared,
    config: CONFIG,
    warnings: [],
    accounts: new AccountRegistry(),
    getEngine: () => shared,
    obo,
    oboEngineFor: () => perUser,
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(() => {
  server.close();
});

async function ask(question: string, token?: string): Promise<Response> {
  return fetch(base + "/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ question }),
  });
}

test("without an Authorization header the shared engine answers", async () => {
  const res = await ask("anonymous question");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { answer: "shared: anonymous question", citations: [], engine: "mock", durationMs: 1 });
  assert.ok(shared.asks.includes("anonymous question"));
  assert.ok(!perUser.asks.includes("anonymous question"));
});

test("a Teams SSO token routes the request to the per-user engine", async () => {
  const res = await ask("delegated question", "sso-token");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).answer, "per-user: delegated question");
  assert.ok(perUser.asks.includes("delegated question"));
  assert.ok(!shared.asks.includes("delegated question"));
});

test("GET /api/meta reports the signed-in identity", async () => {
  const anon = await (await fetch(base + "/api/meta")).json();
  assert.deepEqual(anon.sso, { enabled: false, configured: true });

  const res = await fetch(base + "/api/meta", { headers: { authorization: "Bearer sso-token" } });
  const meta = await res.json();
  assert.equal(meta.sso.enabled, true);
  assert.equal(meta.sso.configured, true);
  assert.deepEqual(meta.sso.identity, { name: "Alice Adams", upn: "alice@contoso.com" });
  assert.equal(meta.engine.label, "per-user");
});

test("a failed exchange answers 401 and never falls back to the shared engine", async () => {
  exchangeFails = new AskError("OBO_CONSENT_REQUIRED", "consent missing", "grant admin consent");
  const before = shared.asks.length;
  try {
    const res = await ask("should not reach an engine", "sso-token");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "consent missing", code: "OBO_CONSENT_REQUIRED", hint: "grant admin consent" });

    const chat = await fetch(base + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sso-token" },
      body: JSON.stringify({ question: "should not stream" }),
    });
    assert.equal(chat.status, 401);
    assert.equal((await chat.json()).code, "OBO_CONSENT_REQUIRED");
  } finally {
    exchangeFails = undefined;
  }
  assert.equal(shared.asks.length, before);
});

test("/api/health stays anonymous", async () => {
  const res = await fetch(base + "/api/health");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});
