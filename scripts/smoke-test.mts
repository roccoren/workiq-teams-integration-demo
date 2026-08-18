// End-to-end smoke test: boots the demo (mock engine), exercises every surface.
import { startServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({ ...process.env, WORKIQ_MODE: "mock", PORT: "0", WORKIQ_STREAM_CHUNK_MS: "1" });
const boot = await startServer(config);
const base = `http://127.0.0.1:${boot.port}`;
console.log("mode:", boot.resolvedMode, "| port:", boot.port);

const results: string[] = [];
const step = async (name: string, fn: () => Promise<unknown>) => {
  const t0 = Date.now();
  try {
    const v = await fn();
    results.push(`✔ ${name} (${Date.now() - t0}ms)${typeof v === "string" ? " — " + v : ""}`);
  } catch (e) {
    results.push(`✘ ${name}: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
};

await step("meta", async () => {
  const m = await (await fetch(base + "/api/meta")).json();
  return `mode=${m.mode}, engine=${m.engine.label}`;
});
await step("ask (one-shot)", async () => {
  const r = await (await fetch(base + "/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "Who owns Project Atlas?" }) })).json();
  return `${r.citations.length} citations, ${r.answer.length} chars`;
});
await step("chat (SSE)", async () => {
  const res = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "What meetings do I have this week?" }) });
  const text = await res.text();
  const events = [...text.matchAll(/event: (\w+)/g)].map((m) => m[1]);
  return events.join(",");
});
await step("retrieve", async () => {
  const r = await (await fetch(base + "/api/retrieve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queries: ["Project Atlas"] }) })).json();
  return `${r.resultCount} hits`;
});
await step("fetch-blob", async () => {
  const r = await (await fetch(base + "/api/fetch-blob", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "/documents/d1/content" }) })).json();
  return `${r.sizeBytes} bytes base64`;
});
await step("search-paths", async () => {
  const r = await (await fetch(base + "/api/search-paths", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: "calendar" }) })).json();
  return `${r.paths.length} paths`;
});
await step("brief", async () => {
  const r = await (await fetch(base + "/api/brief", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "T", items: [{ question: "q", answer: "a", citations: [] }] }) })).json();
  return `${r.markdown.length} chars md`;
});
await step("static UI", async () => {
  const res = await fetch(base + "/");
  return `HTTP ${res.status}`;
});

boot.server.close();
await boot.engine.close();
console.log(results.join("\n"));
console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE OK");
process.exit(process.exitCode ?? 0);
