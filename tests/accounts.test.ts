// Unit tests for per-user account resolution (Work IQ multi-account mode).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountRegistry } from "../src/workiq/accounts.js";

test("registry parses WORKIQ_ACCOUNTS (first = default)", () => {
  const r = new AccountRegistry("alice@contoso.com, bob@contoso.com ", undefined);
  assert.deepEqual(r.list, ["alice@contoso.com", "bob@contoso.com"]);
  assert.equal(r.defaultAccount, "alice@contoso.com");
  assert.ok(r.has("BOB@contoso.com"), "case-insensitive");
});

test("registry loads account map file and drops unknown emails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workiq-map-"));
  const file = path.join(dir, "map.json");
  fs.writeFileSync(file, JSON.stringify({
    "alice@contoso.com": "alice@contoso.com",
    "3f2a1b…": "bob@contoso.com",
    "unknown-key": "nobody@else.com",
  }));
  const r = new AccountRegistry("alice@contoso.com,bob@contoso.com", file);
  assert.equal(r.mapSize, 2);
  // the map key "alice@contoso.com" (same string as the email) wins over the plain-email fallback
  assert.deepEqual(r.resolve({ email: "alice@contoso.com" }), { account: "alice@contoso.com", matchedBy: "alice@contoso.com" });
  // matchedBy reports the raw map key that matched
  assert.deepEqual(r.resolve({ aadObjectId: "3f2a1b…" }), { account: "bob@contoso.com", matchedBy: "3f2a1b…" });
});

test("resolution falls back to default when unmapped", () => {
  const r = new AccountRegistry("alice@contoso.com,bob@contoso.com", undefined);
  const res = r.resolve({ id: "29:unknown", name: "Visitor" });
  assert.equal(res.account, "alice@contoso.com");
});

test("normalize validates client-supplied accounts", () => {
  const r = new AccountRegistry("alice@contoso.com,bob@contoso.com", undefined);
  assert.equal(r.normalize("bob@contoso.com"), "bob@contoso.com");
  assert.equal(r.normalize("nobody@else.com"), undefined);
  assert.equal(r.normalize(undefined), "alice@contoso.com");
});