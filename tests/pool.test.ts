// Pool: one MCP process per Work IQ account, spawned with --account <email>.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpClientPool } from "../src/workiq/pool.js";

test("pool spawns per-account MCP servers with --account", () => {
  const pool = new McpClientPool({ command: ["workiq"], account: "default@contoso.com" });
  const alice = pool.get("alice@contoso.com");
  const bob = pool.get("bob@contoso.com");
  const again = pool.get("alice@contoso.com");
  pool.get(); // default client (lazy)
  assert.equal(alice, again, "same account reuses the same client");
  assert.equal(pool.size, 3, "default + 2 accounts");
  const cmds = pool.describeClients();
  const aliceCmd = cmds.find((c) => c.key === "alice@contoso.com")!.command.join(" ");
  const defCmd = cmds.find((c) => c.key === "default@contoso.com")!.command.join(" ");
  assert.ok(aliceCmd.includes("--account alice@contoso.com"), "alice's server uses her account");
  assert.ok(defCmd.includes("--account default@contoso.com"), "configured default account is explicit");
});

test("pool without a configured default spawns without --account", () => {
  const pool = new McpClientPool({ command: ["workiq"] });
  pool.get(); // default client
  const defCmd = pool.describeClients().find((c) => c.key === "")!.command.join(" ");
  assert.ok(!defCmd.includes("--account"), "no accounts configured -> rely on the CLI's cached default");
});

test("pool closes per-account clients", async () => {
  const pool = new McpClientPool({ command: ["workiq"] });
  pool.get("a@x.com");
  pool.get("b@x.com");
  assert.equal(pool.size, 2);
  await pool.close("a@x.com");
  assert.equal(pool.size, 1);
  await pool.closeAll();
  assert.equal(pool.size, 0);
});