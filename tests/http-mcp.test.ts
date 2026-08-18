// HttpMcpClient: the Streamable HTTP MCP transport used for the hosted Work IQ endpoint.
// Driven against a real node:http server so the wire behaviour (headers, SSE framing,
// session id, DELETE teardown, error mapping) is exercised end to end.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { HttpMcpClient } from "../src/workiq/http-mcp-client.js";
import { AskError } from "../src/workiq/types.js";

const SESSION_ID = "sess-abc-123";

interface Seen {
  method: string;
  rpc?: string;
  auth?: string;
  accept?: string;
  protocol?: string;
  session?: string;
}

let server: http.Server;
let url: string;
let seen: Seen[] = [];
/** Set by a test to make the next tools/call answer over SSE instead of JSON. */
let sseNextCall = false;
/** Set by a test to make the next request fail with this HTTP status. */
let failStatus = 0;
/** Set by a test to make the next tools/call answer with a JSON-RPC error object. */
let rpcErrorNextCall = false;
/** When set, the server only accepts this protocol version on initialize. */
let onlyProtocol = "";

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? (JSON.parse(raw) as { id?: number; method?: string }) : undefined;
      seen.push({
        method: req.method ?? "",
        rpc: body?.method,
        auth: req.headers.authorization,
        accept: req.headers.accept,
        protocol: req.headers["mcp-protocol-version"] as string | undefined,
        session: req.headers["mcp-session-id"] as string | undefined,
      });

      if (failStatus) {
        const status = failStatus;
        failStatus = 0;
        res.writeHead(status, { "content-type": "application/json", "request-id": "req-42" });
        res.end(JSON.stringify({ error: "denied" }));
        return;
      }

      if (req.method === "DELETE") {
        res.writeHead(204).end();
        return;
      }

      // Notification: no id, no response payload.
      if (body?.id === undefined) {
        res.writeHead(202).end();
        return;
      }

      if (body.method === "initialize") {
        const requested = req.headers["mcp-protocol-version"] as string;
        if (onlyProtocol && requested !== onlyProtocol) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `Unsupported protocol version: ${requested}` } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": SESSION_ID });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: requested, capabilities: {}, serverInfo: { name: "workiq", version: "1" } } }));
        return;
      }

      if (body.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "ask" }, { name: "retrieve" }] } }));
        return;
      }

      if (body.method === "tools/call") {
        if (rpcErrorNextCall) {
          rpcErrorNextCall = false;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "tenant policy blocked this query" } }));
          return;
        }
        if (sseNextCall) {
          sseNextCall = false;
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
          // A notification frame and a frame for another id must both be ignored.
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`);
          res.write(`: keep-alive\n\n`);
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 9999, result: { content: [{ type: "text", text: "wrong id" }] } })}\n\n`);
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "streamed answer" }], structuredContent: { answer: "streamed answer" } } })}\n\n`);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "json answer" }], structuredContent: { answer: "json answer" } } }));
        return;
      }

      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown method" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

after(() => {
  server.close();
});

test("initialize + tools/list over JSON, with the documented headers", async () => {
  seen = [];
  const client = new HttpMcpClient({ url, accessToken: "tok-1" });
  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["ask", "retrieve"]);

  const init = seen.find((s) => s.rpc === "initialize");
  assert.ok(init, "initialize was sent");
  assert.equal(init.method, "POST");
  assert.equal(init.auth, "Bearer tok-1");
  assert.equal(init.accept, "application/json, text/event-stream");
  assert.equal(init.protocol, "2025-06-18");

  assert.ok(seen.some((s) => s.rpc === "notifications/initialized"), "initialized notification was sent");
  await client.close();
});

test("tools/call returns JSON content", async () => {
  const client = new HttpMcpClient({ url, accessToken: "tok-1" });
  const res = await client.callTool("ask", { question: "hi" });
  assert.equal(res.content[0]?.text, "json answer");
  assert.equal(res.isError, false);
  await client.close();
});

test("tools/call resolves from an SSE stream, ignoring unrelated frames", async () => {
  sseNextCall = true;
  const client = new HttpMcpClient({ url, accessToken: "tok-1" });
  const res = await client.callTool("ask", { question: "hi" });
  assert.equal(res.content[0]?.text, "streamed answer");
  assert.deepEqual(res.structuredContent, { answer: "streamed answer" });
  await client.close();
});

test("the Mcp-Session-Id is echoed on later requests and released with DELETE", async () => {
  seen = [];
  const client = new HttpMcpClient({ url, accessToken: "tok-1" });
  await client.listTools();
  await client.callTool("ask", { question: "hi" });

  const init = seen.find((s) => s.rpc === "initialize");
  assert.equal(init?.session, undefined, "no session id before the server issues one");
  assert.ok(seen.filter((s) => s.rpc === "tools/list" || s.rpc === "tools/call").every((s) => s.session === SESSION_ID));

  await client.close();
  const del = seen.find((s) => s.method === "DELETE");
  assert.ok(del, "close() released the session");
  assert.equal(del.session, SESSION_ID);
});

test("caches tools until force", async () => {
  seen = [];
  const client = new HttpMcpClient({ url, accessToken: "tok-1" });
  await client.listTools();
  await client.listTools();
  assert.equal(seen.filter((s) => s.rpc === "tools/list").length, 1);
  await client.listTools(true);
  assert.equal(seen.filter((s) => s.rpc === "tools/list").length, 2);
  await client.close();
});

test("HTTP 401 maps to AskError WORKIQ_UNAUTHORIZED with a consent hint", async () => {
  failStatus = 401;
  const client = new HttpMcpClient({ url, accessToken: "bad" });
  await assert.rejects(
    () => client.listTools(),
    (e: unknown) => {
      assert.ok(e instanceof AskError);
      assert.equal(e.code, "WORKIQ_UNAUTHORIZED");
      assert.match(e.hint ?? "", /WorkIQAgent\.Ask/);
      return true;
    },
  );
  await client.close();
});

test("HTTP 429 maps to ENGINE_UNAVAILABLE and surfaces the request-id", async () => {
  failStatus = 429;
  const client = new HttpMcpClient({ url, accessToken: "tok-1" });
  await assert.rejects(
    () => client.listTools(),
    (e: unknown) => {
      assert.ok(e instanceof AskError);
      assert.equal(e.code, "ENGINE_UNAVAILABLE");
      assert.match(e.message, /429/);
      assert.match(e.message, /req-42/);
      return true;
    },
  );
  await client.close();
});

test("a JSON-RPC error object maps to AskError ENGINE_ERROR", async () => {
  const client = new HttpMcpClient({ url, accessToken: "tok-1" });
  rpcErrorNextCall = true;
  await assert.rejects(
    () => client.callTool("ask", { question: "hi" }),
    (e: unknown) => {
      assert.ok(e instanceof AskError);
      assert.equal(e.code, "ENGINE_ERROR");
      assert.match(e.message, /tenant policy blocked/);
      return true;
    },
  );
  await client.close();
});

test("falls back to an older protocol version when initialize is rejected", async () => {
  seen = [];
  onlyProtocol = "2024-11-05";
  try {
    const client = new HttpMcpClient({ url, accessToken: "tok-1" });
    await client.listTools();
    const attempts = seen.filter((s) => s.rpc === "initialize").map((s) => s.protocol);
    assert.deepEqual(attempts, ["2025-06-18", "2024-11-05"]);
    // Later requests keep the negotiated version.
    assert.equal(seen.find((s) => s.rpc === "tools/list")?.protocol, "2024-11-05");
    await client.close();
  } finally {
    onlyProtocol = "";
  }
});
